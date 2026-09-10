import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { OPENCLAW_DESKTOP_GATEWAY_CAPS } from '../../../shared/cowork/approval';

const explicitFixture = process.env.LOBSTER_APPROVAL_RUNTIME_FIXTURE;
const platformName = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : process.platform;
const fixtureRoot = explicitFixture ? path.resolve(explicitFixture) : [
  `${platformName}-${process.arch}`, 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64', 'win-x64',
].map(target => path.resolve('vendor/openclaw-runtime', target)).find(candidate => fs.existsSync(path.join(candidate, 'package.json')));

/** Optional artifact contract: regular protocol/controller fixtures do not require vendor downloads.
 * An explicitly supplied or installed artifact must satisfy the pinned contract; only absence of
 * all optional artifacts skips this suite. Set LOBSTER_APPROVAL_RUNTIME_FIXTURE to its package root.
 */
describe.skipIf(!fixtureRoot)('OpenClaw 2026.8.1 shipped approval contract (requires optional runtime artifact)', () => {
  const root = fixtureRoot!;
  const read = (name: string) => fs.readFileSync(path.join(root, 'dist', name), 'utf8');
  const functionSource = (source: string, name: string): string => {
    const start = source.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end + 2);
  };
  it('pins the shipped runtime to the contract version and verifies advertised method schemas', () => {
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).toBe('2026.8.1');
    const schema = read('src-DG6qdQYv.js');
    expect(schema).toContain('const ApprovalGetResultSchema = closedObject({ approval: ApprovalSnapshotSchema })');
    expect(schema).toContain('const ApprovalResolveResultSchema = closedObject({\n\tapplied: Type.Boolean(),\n\tapproval: TerminalApprovalSnapshotSchema');
    expect(schema).toContain('bootId: Type.Optional(Type.String(');
    expect(schema).toContain('methods: Type.Array(NonEmptyString)');
    const handler = read('approval-CBO9Lt0X.js');
    expect(handler).toContain('"approval.get":'); expect(handler).toContain('"approval.resolve":');
    expect(handler).toContain('applied: false'); expect(handler).toContain('applied: resolution.applied');
  });
  it('verifies the installed Codex plugin exact network producer and single-use approval protocol', () => {
    const producer = read('dynamic-tools-BCQx2SGo.js');
    expect(producer).toContain('"Codex app-server network approval"');
    expect(producer).toContain('toolName: networkApproval ? "codex_network_approval"');
    expect(producer).toContain('`Network: ${sanitizePermissionScalar(networkApproval.protocol)}://${sanitizePermissionHostValue(networkApproval.host)}`');
    const bridge = read('plugin-approval-roundtrip-PvjhudTm.js');
    expect(bridge).toContain('params.hostCapabilities.requestApproval({');
    expect(bridge).toContain('params.allowedDecisions ? { allowedDecisions: params.allowedDecisions }');
    expect(bridge).toContain('case "allow-once": return "approved-once"');
  });
  it('routes desktop caps to both actual approval kinds and uses the bundled protocol 4 client', () => {
    const source = read('server-request-context-YipMKoq4.js');
    const canDeliver = runInNewContext(`(${functionSource(source, 'canDeliverApprovals')})`, {
      ALL_APPROVAL_CLIENT_IDS: new Set(), EXEC_APPROVAL_CLIENT_IDS: new Set(), PLUGIN_APPROVAL_CLIENT_IDS: new Set(),
      GATEWAY_CLIENT_CAPS: { APPROVALS: 'approvals', EXEC_APPROVALS: 'exec-approvals', PLUGIN_APPROVALS: 'plugin-approvals' },
      hasGatewayClientCap: (caps: string[], cap: string) => caps.includes(cap),
    }) as (client: unknown, kind: string) => boolean;
    const client = (caps: readonly string[]) => ({ connect: { scopes: ['operator.admin'], client: { id: 'gateway-client' }, caps } });
    for (const kind of ['exec', 'plugin']) {
      expect(canDeliver(client(['tool-events']), kind)).toBe(false);
      expect(canDeliver(client(OPENCLAW_DESKTOP_GATEWAY_CAPS), kind)).toBe(true);
    }
    const gatewayClient = read('client-CYazuu8_.js');
    expect(gatewayClient).toContain('this.opts.maxProtocol ?? 4');
    expect(gatewayClient).toContain('clientMode === GATEWAY_CLIENT_MODES.NODE ? 3 : 4');
  });
  it('keeps a normal desktop webchat exec in the original turn until approval resolves', () => {
    const chat = read('chat-send-handler-CXr8Gdg1.js');
    const route = runInNewContext(`(${functionSource(chat, 'resolveChatSendOriginatingRoute')})`, {
      INTERNAL_MESSAGE_CHANNEL: 'webchat',
    }) as (params: unknown) => { originatingChannel: string };
    const channel = route({ deliver: false, sessionKey: 'agent:main:desktop:s' }).originatingChannel;
    expect(channel).toBe('webchat');
    const nativeSource = functionSource(read('message-channel-BDnZaHN4.js'), 'isNativeApprovalChannel');
    const exec = read('bash-tools-3rgGHPCr.js');
    const inline = runInNewContext(`${nativeSource}\n(${functionSource(exec, 'shouldAwaitExecApprovalInline')})`, {
      normalizeMessageChannel: (value: unknown) => value, listBundledChannelCatalogEntries: () => [],
    }) as (params: unknown) => boolean;
    expect(inline({ turnSourceChannel: channel })).toBe(true);
    expect(inline({ turnSourceChannel: channel, approvalFollowupMode: 'agent' })).toBe(false);
    const branch = exec.slice(exec.indexOf('if (unavailableReason === null && shouldAwaitExecApprovalInline(params))'), exec.indexOf('const effectiveTimeout =', exec.indexOf('if (unavailableReason === null && shouldAwaitExecApprovalInline(params))')));
    expect(branch).toContain('phase: "waiting-approval"');
    expect(branch).toContain('approvalDecision = await resolveApprovalForExecution');
    expect(branch).toContain('phase: "approval-resolved"');
    expect(branch).not.toContain('pendingResult:');
  });
});
