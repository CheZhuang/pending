// Where the CLI keeps Agentree state: a user-level application data directory,
// never the project directory (zero project pollution). Same root as B's adapters.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function agentreeHome(env: NodeJS.ProcessEnv): string {
  if (env.AGENTREE_HOME) return env.AGENTREE_HOME;
  const root = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(root, 'agentree');
}

export interface CliConfig {
  currentWorkspaceId?: string;
}

export class Home {
  constructor(readonly dir: string) {}
  get dbPath() {
    return join(this.dir, 'agentree.sqlite');
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
