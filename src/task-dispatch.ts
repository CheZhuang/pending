import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../packages/storage/src/index.js';
import { DomainError, type Session } from '../packages/contracts/src/index.js';

export type TaskStatus = 'submitted'|'delivery-pending'|'native-accepted'|'running'|'completed'|'failed'|'delivery-unavailable'|'cancel-requested'|'cancelled'|'outcome-unknown';
export interface TaskRequest {
  id:string; requestId:string; workspaceId:string; branchId:string; sessionId:string; runtime:string;
  instructions:string; includeMain:boolean; mainContext:{revision:number;entries:{id:string;body:string}[]} | null;
  submittedBy:string; submittedAt:string;
}
export interface DispatchTask extends TaskRequest { status:TaskStatus; updatedAt:string; nativeTurnId?:string; reason?:string; }
type Emit = (type:string,task:DispatchTask)=>void;
const terminal=new Set<TaskStatus>(['completed','failed','delivery-unavailable','cancelled','outcome-unknown']);

/** Durable request + mutable delivery evidence. The native credential never enters a task row. */
export class TaskDispatch {
  private readonly runners=new Map<string,number>();
  constructor(private readonly store:SqliteStore,private readonly emit:Emit) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS gateway_tasks (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      status TEXT NOT NULL, updated_at TEXT NOT NULL, native_turn_id TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS gateway_tasks_session ON gateway_tasks(json_extract(request_json,'$.sessionId'));
      CREATE INDEX IF NOT EXISTS gateway_tasks_session_status ON gateway_tasks(json_extract(request_json,'$.sessionId'),status);
      CREATE INDEX IF NOT EXISTS gateway_tasks_native_turn ON gateway_tasks(json_extract(request_json,'$.sessionId'),native_turn_id);
      CREATE INDEX IF NOT EXISTS gateway_tasks_inflight ON gateway_tasks(status);
      CREATE INDEX IF NOT EXISTS gateway_task_native_events ON events(workspace_id,json_extract(data,'$.sessionId'),
        coalesce(json_extract(data,'$.payload.params.turn.id'),json_extract(data,'$.payload.params.turnId')),sequence);
      CREATE TRIGGER IF NOT EXISTS gateway_task_request_immutable BEFORE UPDATE ON gateway_tasks
        WHEN OLD.request_json != NEW.request_json OR OLD.request_id != NEW.request_id OR OLD.id != NEW.id
        BEGIN SELECT RAISE(ABORT,'task request is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS gateway_task_delete BEFORE DELETE ON gateway_tasks
        BEGIN SELECT RAISE(ABORT,'task history cannot be deleted'); END;`);
    // Any nonterminal native work may have progressed without a durable terminal
    // observation. Do not leave stale active states blocking this session's queue,
    // and never redeliver work whose native outcome is uncertain.
    const inFlight=this.store.db.prepare("SELECT id FROM gateway_tasks WHERE status IN ('delivery-pending','native-accepted','running','cancel-requested')").all() as {id:string}[];
    for(const task of inFlight)this.transition(this.get(task.id),'outcome-unknown','Gateway restarted before terminal native evidence');
  }
  private row(id:string):DispatchTask|undefined {
    const r=this.store.db.prepare('SELECT request_json,status,updated_at,native_turn_id,reason FROM gateway_tasks WHERE id=?').get(id) as {request_json:string;status:TaskStatus;updated_at:string;native_turn_id:string|null;reason:string|null}|undefined;
    return r?this.taskFromRow(r):undefined;
  }
  private taskFromRow(r:{request_json:string;status:TaskStatus;updated_at:string;native_turn_id:string|null;reason:string|null}):DispatchTask {
    return {...JSON.parse(r.request_json) as TaskRequest,status:r.status,updatedAt:r.updated_at,...(r.native_turn_id?{nativeTurnId:r.native_turn_id}:{}),...(r.reason?{reason:r.reason}:{})};
  }
  get(id:string):DispatchTask {const t=this.row(id);if(!t)throw new DomainError('NOT_FOUND','Task not found');return t;}
  byRequestId(requestId:string):DispatchTask|undefined {const r=this.store.db.prepare('SELECT id FROM gateway_tasks WHERE request_id=?').get(requestId) as {id:string}|undefined;return r?this.get(r.id):undefined;}
  list(sessionId?:string):DispatchTask[] {
    const sql="SELECT request_json,status,updated_at,native_turn_id,reason FROM gateway_tasks"+(sessionId?" WHERE json_extract(request_json,'$.sessionId')=?":"")+' ORDER BY rowid DESC';
    const rows=sessionId?this.store.db.prepare(sql).all(sessionId):this.store.db.prepare(sql).all();
    return rows.map(r=>this.taskFromRow(r as {request_json:string;status:TaskStatus;updated_at:string;native_turn_id:string|null;reason:string|null}));
  }
  heartbeat(sessionId:string):void {this.runners.set(sessionId,Date.now());}
  available(sessionId:string):boolean {return Date.now()-(this.runners.get(sessionId)??0)<5000;}
  submit(input:{requestId:string;instructions:string;includeMain:boolean;mainContext:TaskRequest['mainContext']},session:Session):DispatchTask {
    const prior=this.store.db.prepare('SELECT id FROM gateway_tasks WHERE request_id=?').get(input.requestId) as {id:string}|undefined;
    if(prior){const t=this.get(prior.id);if(t.sessionId!==session.id||t.instructions!==input.instructions||t.includeMain!==input.includeMain)throw new DomainError('STATE','Request ID already used for a different task');return t;}
    const now=new Date().toISOString();
    const request:TaskRequest={id:randomUUID(),requestId:input.requestId,workspaceId:session.workspaceId,branchId:session.branchId,sessionId:session.id,runtime:session.runtime,instructions:input.instructions,includeMain:input.includeMain,mainContext:input.mainContext,submittedBy:'local-admin',submittedAt:now};
    const supported=session.runtime==='codex-app-server'&&this.available(session.id);
    const task:DispatchTask={...request,status:supported?'submitted':'delivery-unavailable',updatedAt:now,...(!supported?{reason:session.runtime==='claude-code'?'Existing Claude CLI sessions cannot accept unsolicited tasks':'No connected managed Codex runner'}:{})};
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO gateway_tasks(id,request_id,request_json,status,updated_at,native_turn_id,reason) VALUES(?,?,?,?,?,?,?)').run(request.id,request.requestId,JSON.stringify(request),task.status,now,null,task.reason??null);this.emit('task.submitted',task);if(!supported)this.emit('task.delivery-unavailable',task);});
    return task;
  }
  private transition(task:DispatchTask,status:TaskStatus,reason?:string,nativeTurnId?:string):DispatchTask {
    const updated={...task,status,updatedAt:new Date().toISOString(),...(reason?{reason}:{}),...(nativeTurnId?{nativeTurnId}:{})};
    this.store.transaction(()=>{this.store.db.prepare('UPDATE gateway_tasks SET status=?,updated_at=?,native_turn_id=?,reason=? WHERE id=?').run(status,updated.updatedAt,updated.nativeTurnId??null,updated.reason??null,task.id);this.emit(`task.${status}`,updated);});
    return updated;
  }
  claim(sessionId:string):DispatchTask|null {
    this.heartbeat(sessionId);
    const active=this.store.db.prepare("SELECT 1 AS active FROM gateway_tasks WHERE json_extract(request_json,'$.sessionId')=? AND status IN ('delivery-pending','native-accepted','running','cancel-requested') LIMIT 1").get(sessionId);
    if(active)return null;
    const oldest=this.store.db.prepare("SELECT id FROM gateway_tasks WHERE json_extract(request_json,'$.sessionId')=? AND status='submitted' ORDER BY rowid ASC LIMIT 1").get(sessionId) as {id:string}|undefined;
    const task=oldest?this.get(oldest.id):undefined;
    return task?this.transition(task,'delivery-pending'):null;
  }
  accepted(id:string,sessionId:string,nativeTurnId:string):DispatchTask {
    const t=this.get(id);if(t.sessionId!==sessionId)throw new DomainError('DENY','Task belongs to another session');
    if(t.nativeTurnId===nativeTurnId)return t;
    if(t.status!=='delivery-pending'&&t.status!=='cancel-requested'&&t.status!=='outcome-unknown')throw new DomainError('STATE','Task is not awaiting native acceptance');
    const accepted=this.transition(t,'native-accepted',undefined,nativeTurnId);
    if(t.status==='cancel-requested')this.transition(accepted,'cancel-requested','Human requested interruption');
    // Native observations can race ahead of the turn/start HTTP acknowledgement.
    const events=this.store.db.prepare(`SELECT data FROM events
      WHERE workspace_id=? AND json_extract(data,'$.sessionId')=?
        AND json_extract(data,'$.type') IN ('turn/started','turn/completed')
        AND coalesce(json_extract(data,'$.payload.params.turn.id'),json_extract(data,'$.payload.params.turnId')) =?
      ORDER BY sequence`).all(t.workspaceId,sessionId,nativeTurnId) as {data:string}[];
    for(const row of events){const e=JSON.parse(row.data) as {type:string;payload:unknown};this.observe(sessionId,e.type,e.payload);}
    return this.get(id);
  }
  unavailable(id:string,sessionId:string,reason:string):DispatchTask {
    const t=this.get(id);if(t.sessionId!==sessionId)throw new DomainError('DENY','Task belongs to another session');
    if(t.status==='cancel-requested'&&!t.nativeTurnId)return this.transition(t,'cancelled','Cancelled before native delivery');
    if(t.status!=='delivery-pending')return t;
    // An RPC error can occur after native acceptance; absence of a turn ID is uncertain.
    return this.transition(t,'outcome-unknown',reason);
  }
  cancel(id:string):DispatchTask {
    const t=this.get(id);if(terminal.has(t.status))return t;
    if(t.status==='submitted')return this.transition(t,'cancelled','Cancelled before native delivery');
    return this.transition(t,'cancel-requested','Human requested interruption');
  }
  observe(sessionId:string,type:string,payload:unknown):void {
    if(type!=='turn/started'&&type!=='turn/completed')return;
    const p=payload as {params?:{turn?:{id?:string;status?:string;error?:unknown};turnId?:string}};
    const nativeTurnId=p?.params?.turn?.id??p?.params?.turnId;
    if(!nativeTurnId)return;
    const match=this.store.db.prepare("SELECT id FROM gateway_tasks WHERE native_turn_id=? AND json_extract(request_json,'$.sessionId')=?").get(nativeTurnId,sessionId) as {id:string}|undefined;
    const task=match?this.get(match.id):undefined;
    if(!task||(terminal.has(task.status)&&task.status!=='outcome-unknown'))return;
    if(type==='turn/started'&&task.status==='native-accepted')this.transition(task,'running');
    if(type==='turn/completed') {
      const nativeStatus=p?.params?.turn?.status;
      this.transition(task,nativeStatus==='completed'?'completed':'failed',nativeStatus&&nativeStatus!=='completed'?`Native turn status: ${nativeStatus}`:undefined);
    }
  }
  sessionEnded(sessionId:string):void {
    const active=this.store.db.prepare("SELECT id FROM gateway_tasks WHERE json_extract(request_json,'$.sessionId')=? AND status IN ('submitted','delivery-pending','native-accepted','running','cancel-requested')").all(sessionId) as {id:string}[];
    for(const row of active){const t=this.get(row.id);this.transition(t,t.status==='submitted'?'delivery-unavailable':'outcome-unknown','Session ended without terminal task evidence');}
    this.runners.delete(sessionId);
  }
}
