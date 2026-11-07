export interface ClaudeSettings {
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
}

export function createClaudeHookSettings(command: string, timeoutSeconds = 120): ClaudeSettings {
  return {
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: timeoutSeconds }],
      }],
    },
  };
}
