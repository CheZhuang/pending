import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeConnection } from './gateway-client.js';

export function nativeMcpConfig(database:string, connection:NativeConnection) {
  const extension=fileURLToPath(import.meta.url).endsWith('.ts')?'.ts':'.js';
  const entry=join(dirname(fileURLToPath(import.meta.url)),'../../mcp/src',`native-entry${extension}`);
  return {command:process.execPath,args:[...(extension==='.ts'?['--import',import.meta.resolve('tsx')]:[]),entry],env:{
    HARNESS_GATEWAY_URL:connection.gatewayUrl,HARNESS_SESSION_ID:connection.sessionId,HARNESS_SESSION_TOKEN:connection.sessionToken,AGENTREE_DATABASE_PATH:database,
  }};
}
