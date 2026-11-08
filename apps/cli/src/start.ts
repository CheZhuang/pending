import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { agentreeHome } from './home.js';
import { localHumanHeaders } from '../../../packages/adapters/src/local-auth.js';

/** Bind is the daemon singleton lock; never fall back to a different port or database. */
export async function startLocal(): Promise<string> {
  const home = resolve(agentreeHome(process.env));
  const port = Number(process.env.PORT ?? 8787);
  const url = `http://127.0.0.1:${port}`;
  const check = async () => {
    let response: Response;
    try { response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }); }
    catch { return false; }
    const data = await response.json() as { application?: string; database?: string };
    if (data.application !== 'agentree' || data.database !== join(home, 'gateway.sqlite'))
      throw new Error(`Port ${port} belongs to another service or Agentree data directory`);
    return true;
  };
  if (!await check()) {
    mkdirSync(home, {recursive:true, mode:0o700});
    const log = openSync(join(home,'gateway.log'), 'a', 0o600);
    const source = fileURLToPath(new URL('../../../src/index.js', import.meta.url));
    const args = !import.meta.url.endsWith('.ts') ? [source] : ['--import','tsx',source.replace(/\.js$/,'.ts')];
    const child = spawn(process.execPath,args,{detached:true,stdio:['ignore',log,log],env:{...process.env,AGENTREE_HOME:home}});
    closeSync(log);
    let failed: Error | undefined;
    child.on('error', error => { failed = error; });
    child.unref();
    let ready = false;
    for (let i=0;i<80;i++) {
      if (failed) throw failed;
      if (await check()) { ready = true; break; }
      await new Promise(r=>setTimeout(r,100));
    }
    if (!ready) throw new Error(`Gateway did not start; see ${join(home,'gateway.log')}`);
  }
  const response = await fetch(`${url}/v1/console-ticket`, {method:'POST', headers:localHumanHeaders(url, join(home,'gateway.sqlite')), redirect:'error', signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error(`Gateway Console authorization failed: HTTP ${response.status}`);
  const {ticket} = await response.json() as {ticket:string};
  const consoleBase = process.env.AGENTREE_CONSOLE_URL ?? url;
  const target = new URL(consoleBase);
  if (target.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(target.hostname) || target.username || target.password)
    throw new Error('Console URL must be loopback HTTP');
  target.hash = `agentree-ticket=${encodeURIComponent(ticket)}`;
  const consoleUrl = target.toString();
  if (process.env.AGENTREE_NO_OPEN !== '1') {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const browser = spawn(command,[consoleUrl],{stdio:'ignore',detached:true});
    browser.on('error',()=>{}); browser.unref();
  }
  return consoleUrl;
}
