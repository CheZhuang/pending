// Where the CLI keeps Agentree state: the same user-level directory and SQLite
// file as the gateway daemon (src/index.ts), so the CLI, the gateway and the web
// console all see one database. Never the project directory (zero project pollution).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** File name the gateway daemon uses inside its data directory. */
export const DB_FILE = 'gateway.sqlite';

/** AGENTREE_HOME (CLI override), then the gateway's GATEWAY_DATA_DIR, then its default. */
export function agentreeHome(env: NodeJS.ProcessEnv): string {
  return env.AGENTREE_HOME || env.GATEWAY_DATA_DIR || join(homedir(), '.local', 'share', 'agentree');
}

export interface CliConfig {
  currentWorkspaceId?: string;
}

export class Home {
  constructor(readonly dir: string) {}
  get dbPath() {
    return join(this.dir, DB_FILE);
  }
  private get configPath() {
    return join(this.dir, 'cli.json');
  }
  ensure(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  config(): CliConfig {
    try {
      return JSON.parse(readFileSync(this.configPath, 'utf8')) as CliConfig;
    } catch {
      return {};
    }
  }
  saveConfig(config: CliConfig): void {
    this.ensure();
    writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
}
