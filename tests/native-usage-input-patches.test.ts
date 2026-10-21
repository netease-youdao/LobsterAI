import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { afterEach, expect, test } from 'vitest';

const { patchNativeUsageInput } = require('../scripts/openclaw-plugin-patches/native-usage-input.cjs');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test.each([
  ['openclaw-nim-channel', 'RawBody: inboundPromptText,', { inboundPromptText: '引用的旧消息\n请继续', message: { text: '请继续' } }, '请继续'],
  ['openclaw-nim-channel', 'RawBody: resolvedBody,', { resolvedBody: '@显示名 原文', rawBody: '@account 原文' }, '@account 原文'],
  ['dingtalk-connector', 'rawText: userContent,', { userContent: '请描述这张图片\n附件提示', rawText: '' }, ''],
  ['moltbot-popo', 'RawBody: rawBodyWithQuote,', { rawBodyWithQuote: '引用消息\n原文', voiceContent: '', ctx: { content: { text: '原文' } } }, '原文'],
  ['wecom-openclaw-plugin', 'RawBody: finalContent,', { finalContent: '原文\n文件下载错误和工具提示', content: '原文' }, '原文'],
  ['wecom-openclaw-plugin', 'RawBody: messageBody,', { messageBody: '[image]', text: '' }, ''],
  ['wecom-openclaw-plugin', 'RawBody: rawBody,', { rawBody: '正文\n[image] (decryption failed)', params: {}, msg: { mixed: { msg_item: [{ msgtype: 'text', text: { content: '正文' } }, { msgtype: 'image' }] } } }, '正文'],
  ['clawemail-email', 'RawBody: email.textPlain || "",', { email: { textPlain: '', textMarkdown: '**邮件原文**' } }, '**邮件原文**'],
] as const)('preserves original input and model context for %s / %s', (plugin, field, values, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-usage-input-'));
  roots.push(root);
  const dir = path.join(root, plugin);
  fs.mkdirSync(dir);
  // Cover prepared cached entries as well as uncompiled source.
  for (const entry of ['index.ts', 'index.mjs']) fs.writeFileSync(path.join(dir, entry), `({ ${field} })`);
  const before = vm.runInNewContext(`({ ${field} })`, values);
  const context = { runtimeExtensionsDir: root, log: () => {} };
  patchNativeUsageInput(context);
  const first = fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8');
  patchNativeUsageInput(context);
  expect(fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8')).toBe(first);
  for (const entry of ['index.ts', 'index.mjs']) {
    const result = vm.runInNewContext(fs.readFileSync(path.join(dir, entry), 'utf8'), values);
    expect(result).toMatchObject({ ...before, UsageUserMessage: expected });
  }
});

test('WeChat quoted replies retain the quote for the model and only current text for usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-usage-weixin-'));
  roots.push(root);
  const dir = path.join(root, 'openclaw-weixin');
  fs.mkdirSync(dir);
  const entry = path.join(dir, 'index.js');
  fs.writeFileSync(entry, '({ Body: bodyFromItemList(msg.item_list), })');
  patchNativeUsageInput({ runtimeExtensionsDir: root, log: () => {} });
  const result = vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    msg: { item_list: [{ text_item: { text: '继续' }, ref_msg: { title: '旧消息' } }] },
    bodyFromItemList: (items: Array<{ text_item: { text: string }; ref_msg?: { title: string } }>) => items
      .map(item => `${item.ref_msg ? `[引用: ${item.ref_msg.title}]\n` : ''}${item.text_item.text}`).join('\n'),
  });
  expect(result).toEqual({ Body: '[引用: 旧消息]\n继续', UsageUserMessage: '继续' });
});
