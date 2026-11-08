import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// Cold Windows PowerShell/.NET startup can exceed five seconds on hosted
// runners. Keep a finite budget without treating ordinary cold starts as an
// invalid ACL. Never retry a partially completed capability creation.
const SECURITY_TIMEOUT_MS = 30_000;

function securityFailure(message: string, error: unknown): Error {
  const failure = error as { code?: string; status?: number };
  // execFileSync errors can contain the token on stdin: do not attach the raw
  // error as cause, or include its command, stdout, stderr or input.
  const reason = failure.code === 'ETIMEDOUT'
    ? `Windows PowerShell timed out after ${SECURITY_TIMEOUT_MS} ms`
    : 'Windows PowerShell or ACL validation failed';
  return new Error(`${message} (${reason})`);
}

// Windows mode bits do not represent ACLs. Use the OS security descriptor instead.
// Keep paths in the environment, never interpolated into PowerShell source, and
// use LiteralPath so names containing quotes or wildcard characters stay literal.
const identity = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$path = $env:AGENTREE_CAPABILITY_PATH
`;
const validate = `
$acl = $stream.GetAccessControl()
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  throw 'Capability owner does not match the current Windows user'
}
if (-not $acl.AreAccessRulesProtected) { throw 'Capability ACL must disable inheritance' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'Capability ACL must grant access only to the current Windows user'
}
`;

function run(path: string, script: string, input = ''): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Cannot locate Windows security tooling');
  // Absolute system executable, no shell or profile loading, and bounded startup.
  return execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', identity + script], {
      env: {...process.env, AGENTREE_CAPABILITY_PATH: resolve(path)}, input, encoding: 'utf8',
      timeout: SECURITY_TIMEOUT_MS, maxBuffer: 32 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
}

/** Supply the private descriptor to CreateNew, avoiding a publicly accessible creation window. */
export function createWindowsCapability(path: string, token: string): void {
  try {
    run(path, `
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
try {
  $stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::CreateNew,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $acl)
} catch {
  $code = $_.Exception.GetBaseException().HResult -band 65535
  if ($code -eq 80 -or $code -eq 183) { exit 3 }
  throw
}
try {
` + validate + `
  $bytes = [System.Text.Encoding]::ASCII.GetBytes([Console]::In.ReadToEnd())
  $stream.Write($bytes, 0, $bytes.Length)
} finally { $stream.Dispose() }
`, token);
  } catch (error) {
    // Another creator may have won. The caller still validates the existing file.
    if ((error as {status?:number}).status !== 3)
      throw securityFailure('Could not create an owner-only Windows human capability', error);
  }
}

/** Validate the ACL and read from the same handle, denying concurrent writes/deletion. */
export function readWindowsCapability(path: string): string {
  try {
    return run(path, `
$item = Get-Item -LiteralPath $path -Force
if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Capability cannot be a reparse point' }
$stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
` + validate + `
  $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII)
  [Console]::Out.Write($reader.ReadToEnd())
} finally { $stream.Dispose() }
`);
  } catch (error) { throw securityFailure('Gateway human capability must be an owner-only regular file (Windows ACL validation failed)', error); }
}
