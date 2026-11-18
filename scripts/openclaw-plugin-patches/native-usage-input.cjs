'use strict';

const fs = require('fs');
const path = require('path');

// Keep billing display text separate from the channel's prompt/command fields.
// Patch source AND cached compiled entries: plugin preparation can bundle TS
// before the runtime install patch pipeline runs.
function patchNativeUsageInput({ runtimeExtensionsDir, log }) {
  const rules = {
    'openclaw-nim-channel': [
      ['RawBody: inboundPromptText,', 'message.text ?? ""'],
      ['RawBody: resolvedBody,', 'rawBody'],
    ],
    'openclaw-weixin': [
      ['Body: bodyFromItemList(msg.item_list),', 'bodyFromItemList(msg.item_list?.map(item => ({ ...item, ref_msg: undefined })))'],
    ],
    'dingtalk-connector': [
      ['rawText: userContent,', 'rawText'],
    ],
    'moltbot-popo': [
      ['RawBody: rawBodyWithQuote,', 'voiceContent || ctx.content.text || ""'],
    ],
    'wecom-openclaw-plugin': [
      ['RawBody: messageBody,', 'text || ""'],
      ['RawBody: finalContent,', 'content'],
      ['RawBody: rawBody,', 'params.mergedContents ?? msg.text?.content ?? msg.voice?.content ?? (msg.mixed?.msg_item ?? []).filter(item => item.msgtype === "text").map(item => item.text?.content ?? "").join("\\n")'],
    ],
    'clawemail-email': [
      ['RawBody: email.textPlain || "",', 'email.textPlain || email.textMarkdown || ""'],
    ],
  };
  for (const [pluginId, replacements] of Object.entries(rules)) {
    const root = path.join(runtimeExtensionsDir, pluginId);
    if (!fs.existsSync(root)) continue;
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '.git'].includes(entry.name)) visit(file);
          continue;
        }
        if (!entry.isFile() || !/\.(?:ts|js|mjs)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
        const original = fs.readFileSync(file, 'utf8');
        let source = original;
        for (const [anchor, value] of replacements) {
          // The marker follows its anchor so the patch is idempotent for both
          // published source and esbuild's cached, indentation-adjusted output.
          const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          source = source.replace(new RegExp(`(${escaped})(?!\\s*UsageUserMessage:)`, 'g'),
            `$1\n      UsageUserMessage: ${value},`);
        }
        if (pluginId === 'openclaw-weixin' && source.includes('export type WeixinMsgContext = {')
            && !source.includes('UsageUserMessage?: string;')) {
          source = source.replace('export type WeixinMsgContext = {',
            'export type WeixinMsgContext = {\n  UsageUserMessage?: string;');
        }
        if (source !== original) {
          fs.writeFileSync(file, source);
          log(`Patched ${pluginId}/${path.relative(root, file)}: preserve original usage input`);
        }
      }
    };
    visit(root);
  }
}

module.exports = { patchNativeUsageInput };
