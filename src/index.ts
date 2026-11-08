import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway.js';
import { agentreeHome } from '../apps/cli/src/home.js';

const directory = resolve(agentreeHome(process.env));
mkdirSync(directory, {recursive:true, mode:0o700});
const gateway=createGateway({database:join(directory,'gateway.sqlite'),consoleDirectory:fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../apps/web/dist' : '../../apps/web/dist', import.meta.url)),consoleOrigins:(process.env.GATEWAY_CONSOLE_ORIGINS??'').split(',').filter(Boolean)});
const port=Number(process.env.PORT??8787);
gateway.server.on('error', error => { console.error(error.message); process.exit(1); });
gateway.server.listen(port,'127.0.0.1',()=>console.log(`Agentree listening on http://127.0.0.1:${port}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void gateway.close();});
