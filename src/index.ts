import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createGateway } from './gateway.js';

const directory = process.env.GATEWAY_DATA_DIR ?? join(homedir(), '.local', 'share', 'agentree');
mkdirSync(directory, {recursive:true, mode:0o700});
const tokenPath = join(directory,'admin-token');
let adminToken = process.env.HARNESS_ADMIN_TOKEN;
if (!adminToken) {
  try { adminToken=readFileSync(tokenPath,'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    adminToken=randomBytes(32).toString('hex');
    writeFileSync(tokenPath,adminToken+'\n',{mode:0o600,flag:'wx'});
  }
}
const gateway=createGateway({database:join(directory,'gateway.sqlite'),adminToken});
const port=Number(process.env.PORT??8787);
gateway.server.listen(port,'127.0.0.1',()=>console.log(`Gateway listening on http://127.0.0.1:${port}; admin credential: ${tokenPath}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void gateway.close();});
