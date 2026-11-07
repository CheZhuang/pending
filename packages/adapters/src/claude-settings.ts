export interface ClaudeSettings {
  hooks: {
    [event: string]: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string; timeout: number }>;
    }>;
  };
}

export function createClaudeHookSettings(command: string, timeoutSeconds = 120): ClaudeSettings {
  return {
    hooks: {
      PostToolUse: [{matcher:'*',hooks:[{type:'command',command,timeout:30}]}],
      PostToolUseFailure: [{matcher:'*',hooks:[{type:'command',command,timeout:30}]}],
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: timeoutSeconds }],
      }],
    },
  };
}
