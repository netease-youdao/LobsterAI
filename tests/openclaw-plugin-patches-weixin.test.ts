import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  assertWeixinPluginVersion,
  patchWeixinLazyInboundSdk,
  patchWeixinLazyOutboundHooks,
  patchWeixinNarrowSdkImports,
} = require('../scripts/openclaw-plugin-patches/weixin.cjs');

describe('openclaw Weixin plugin startup patches', () => {
  test('uses narrow SDK entry points and defers message-only runtime imports', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const processMessagePath = path.join(tempDir, 'process-message.ts');
    fs.writeFileSync(processMessagePath, [
      'import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";',
      'import {',
      '  resolveSenderCommandAuthorizationWithRuntime,',
      '  resolveDirectDmAuthorizationOutcome,',
      '} from "openclaw/plugin-sdk/command-auth";',
      'import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";',
      'import { logger } from "../util/logger.js";',
      'import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./outbound-hooks.js";',
      'const MEDIA_OUTBOUND_TEMP_DIR = resolvePreferredOpenClawTmpDir();',
      'export async function processOneMessage() {',
      '  const { senderAllowedForCommands, commandAuthorized } =',
      '    await resolveSenderCommandAuthorizationWithRuntime({});',
      '  const directDmOutcome = resolveDirectDmAuthorizationOutcome({ senderAllowedForCommands });',
      '  const typingCallbacks = createTypingCallbacks({});',
      '  const sendingResult = await applyWeixinMessageSendingHook({ to: "to", text: "text" });',
      '  emitWeixinMessageSent({ to: "to", content: sendingResult.text, success: true });',
      '  return { commandAuthorized, directDmOutcome, typingCallbacks, MEDIA_OUTBOUND_TEMP_DIR };',
      '}',
      '',
    ].join('\n'));

    const log = () => {};
    patchWeixinNarrowSdkImports(processMessagePath, 'fixture', log);
    patchWeixinLazyOutboundHooks(
      processMessagePath,
      'fixture',
      './outbound-hooks.js',
      'const MEDIA_OUTBOUND_TEMP_DIR',
      log,
    );
    patchWeixinLazyInboundSdk(processMessagePath, 'fixture', log);
    patchWeixinLazyOutboundHooks(
      processMessagePath,
      'fixture',
      './outbound-hooks.js',
      'const MEDIA_OUTBOUND_TEMP_DIR',
      log,
    );
    patchWeixinLazyInboundSdk(processMessagePath, 'fixture', log);

    const patched = fs.readFileSync(processMessagePath, 'utf8');
    expect(patched).toContain('from "openclaw/plugin-sdk/temp-path"');
    expect(patched).not.toContain('openclaw/plugin-sdk/infra-runtime');
    expect(patched).not.toContain('openclaw/plugin-sdk/channel-runtime');
    expect(patched).not.toContain('from "openclaw/plugin-sdk/command-auth"');
    expect(patched).toContain('await import("openclaw/plugin-sdk/command-auth")');
    expect(patched).toContain('await import("openclaw/plugin-sdk/channel-reply-pipeline")');
    expect(patched).not.toContain(
      'import { applyWeixinMessageSendingHook, emitWeixinMessageSent }',
    );
    expect(patched.match(/lobster_weixin_lazy_outbound_hooks/g)).toHaveLength(1);
    expect(patched.match(/lobster_weixin_lazy_inbound_sdk/g)).toHaveLength(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('routes file locking to the narrow SDK entry point', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    const pairingPath = path.join(tempDir, 'pairing.ts');
    fs.writeFileSync(
      pairingPath,
      'import { withFileLock } from "openclaw/plugin-sdk/infra-runtime";\n',
    );

    patchWeixinNarrowSdkImports(pairingPath, 'fixture', () => {});

    expect(fs.readFileSync(pairingPath, 'utf8'))
      .toContain('from "openclaw/plugin-sdk/file-lock"');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('fails closed when the pinned plugin version changes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-plugin-patch-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ version: '2.5.0' }));

    expect(() => assertWeixinPluginVersion(tempDir)).toThrow(
      'openclaw-weixin startup patch expects 2.4.3, found 2.5.0',
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
