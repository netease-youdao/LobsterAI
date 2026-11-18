import { expect, test } from 'vitest';

import { readUsageContext, UsageEntry, UsageFailureCode, usageFailureCode, usageFailureDetails } from './usage';

function wrapApiError(error: string): string {
  return `SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source.\n${'diagnostic framing\n'.repeat(40)}\n<<<EXTERNAL_UNTRUSTED_CONTENT id="f284b2b3e08e917d">>>\nSource: API\n---\n${error}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="f284b2b3e08e917d">>>`;
}

test('persisted analytics context is allowlisted; raw identity and content cannot pass through', () => {
  const context = readUsageContext({
    taskId: '00000000-0000-4000-8000-000000000001',
    turnId: '00000000-0000-4000-8000-000000000002',
    entry: 'private/path',
    ownerKey: 'private owner',
    prompt: 'private prompt',
    presetId: '/private/path',
    catalogVersion: 'v1',
  });
  expect(context).toMatchObject({
    entry: UsageEntry.Runtime,
    presetId: undefined,
    catalogVersion: 'v1',
  });
  expect(JSON.stringify(context)).not.toContain('private');
  expect(
    readUsageContext({ taskId: 'private-session', turnId: 'private-message' }),
  ).toBeUndefined();
});

test.each([
  ['ENGINE_NOT_READY', UsageFailureCode.EngineNotReady],
  ['40204: private data', UsageFailureCode.Quota],
  ['Timed out reading /private/file', UsageFailureCode.Timeout],
  ['ECONNRESET private-host', UsageFailureCode.Network],
  ['unknown private response body', UsageFailureCode.Unknown],
])('normalizes %s to a bounded failure category', (input, expected) => {
  expect(usageFailureCode(input)).toBe(expected);
});

test.each([
  ['timed out. Restart the OpenClaw gateway. Retry once; browser is currently unavailable.', UsageFailureCode.Timeout],
  ['Web fetch failed (404): 登录 subscription quota 401 429', UsageFailureCode.Http],
  ['Web fetch failed (403): SECURITY NOTICE: external content', UsageFailureCode.Http],
  ['Web fetch failed (503): gateway unavailable', UsageFailureCode.Http],
  ['tab not found: browser tab "t99" not found. Use action=tabs.', UsageFailureCode.TargetUnavailable],
  ['Browser page p99 does not exist.', UsageFailureCode.TargetUnavailable],
  ['Browser element r9 is stale. Take a new snapshot and try again.', UsageFailureCode.TargetUnavailable],
  ['Browser element r9 has no visible box.', UsageFailureCode.TargetUnavailable],
  ['Browser element reference is missing.', UsageFailureCode.ToolArguments],
  ['click requires ref or selector', UsageFailureCode.ToolArguments],
  ['fill requires fields', UsageFailureCode.ToolArguments],
  ['Error: page.evaluate: Error: Invalid evaluate function: quota is not defined', UsageFailureCode.Script],
  ['Chrome MCP subprocess tree cleanup could not be verified.', UsageFailureCode.BrowserBridge],
  ['Chrome MCP process inspection failed for profile "lobster".', UsageFailureCode.BrowserBridge],
  ['Command timed out after 2000 milliseconds: "powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | ForEach-Object { ... }"\n0\\t2026-10-19T17:30:56.2429320', UsageFailureCode.Timeout],
  ['Command timed out after 1000 milliseconds: quota-check --user=401429', UsageFailureCode.Timeout],
  ['Navigation blocked: unsupported protocol "file:"', UsageFailureCode.Policy],
  ['Blocked: resolves to private/internal/special-use IP address', UsageFailureCode.Policy],
  ['Blocked hostname or private/internal/special-use IP address', UsageFailureCode.Policy],
  ['Blocked hostname (configured blocklist): example.com', UsageFailureCode.Policy],
  ['Domain policy: Blocked hostname (not in allowlist): example.com.', UsageFailureCode.Policy],
  ["ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:19423/?quota=401429'", UsageFailureCode.Network],
])('classifies the trusted tool failure instead of its body or recovery advice: %s', (error, expected) => {
  expect(usageFailureCode(error)).toBe(expected);
  expect(usageFailureCode(JSON.stringify({ status: 'error', tool: 'browser', error }))).toBe(expected);
  expect(usageFailureCode(wrapApiError(error))).toBe(expected);
  expect(usageFailureCode(JSON.stringify({ status: 'error', tool: 'browser', error: wrapApiError(error) }))).toBe(expected);
});

test('does not infer product authentication from an arbitrary tool result body', () => {
  expect(usageFailureCode(JSON.stringify({ content: '登录 quota subscription' }))).toBe(UsageFailureCode.Unknown);
});

test('reads the HTTP status outside a nested untrusted error page', () => {
  expect(usageFailureDetails(wrapApiError('Web fetch failed (404): SECURITY NOTICE: 登录 quota subscription')))
    .toEqual({ failureCode: UsageFailureCode.Http, httpStatus: 404 });
  expect(usageFailureCode(wrapApiError('quota').replace('Source: API', 'Source: Web Fetch')))
    .toBe(UsageFailureCode.Unknown);
  expect(usageFailureCode(wrapApiError('quota').replace('<<<END_EXTERNAL', '<<<BROKEN_EXTERNAL')))
    .toBe(UsageFailureCode.Unknown);
});
