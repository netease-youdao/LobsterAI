'use strict';

const fs = require('node:fs');

const RECEIPT_MARKER = 'lobster_weixin_send_receipt_v1';
const DELIVERY_LOG_MARKER = 'lobster_weixin_delivery_log_v1';

function functionEnd(source, start) {
  // A multiline parameter type also has a column-zero brace, followed by `):`.
  // Only a brace on its own line ends the pinned implementation.
  const match = /\r?\n}(?=\r?\n|$)/.exec(source.slice(start));
  return match ? start + match.index + match[0].length : -1;
}

// Backport the sendmessage business receipt check from Tencent plugin 2.4.6.
// Keep the pinned plugin and SDK compatibility patches; never log response bodies.
function patchWeixinSendReceipt(filePath, label, log) {
  if (!fs.existsSync(filePath)) throw new Error(`${label}: required Weixin API file was not found`);
  let src = fs.readFileSync(filePath, 'utf8');
  if (src.includes(RECEIPT_MARKER)) return;
  const start = src.indexOf('export async function sendMessage(');
  const end = functionEnd(src, start);
  const original = src.slice(start, end);
  if (start < 0 || end < 0 || !/await apiPostFetch\(/.test(original)
    || !original.includes('"ilink/bot/sendmessage"')) {
    throw new Error(`${label}: expected sendMessage implementation was not found`);
  }
  const isTypeScript = filePath.endsWith('.ts');
  const patched = original.replace('await apiPostFetch(', 'const rawText = await apiPostFetch(')
    .replace(/\n}$/, `
  // ${RECEIPT_MARKER}
  let receipt${isTypeScript ? ': unknown' : ''};
  try {
    receipt = JSON.parse(rawText);
  } catch {
    throw new Error("WEIXIN_SEND_INVALID_RESPONSE");
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("WEIXIN_SEND_INVALID_RESPONSE");
  }
  const response = receipt${isTypeScript ? ' as Record<string, unknown>' : ''};
  const ret = response.ret === undefined ? 0 : response.ret;
  const errcode = response.errcode === undefined ? 0 : response.errcode;
  if (typeof ret !== "number" || !Number.isSafeInteger(ret)
    || typeof errcode !== "number" || !Number.isSafeInteger(errcode)) {
    throw new Error("WEIXIN_SEND_INVALID_RESPONSE");
  }
  if (ret !== 0 || errcode !== 0) {
    const message = typeof response.errmsg === "string" ? response.errmsg : "";
    // A generic ret=-2 does not establish that the conversation has expired.
    const code = errcode === -14 ? "WEIXIN_ACCOUNT_EXPIRED"
      : /(?:context(?:_token| token)?[^\\n]*(?:expired|invalid)|(?:expired|invalid)[^\\n]*context)/i.test(message)
        ? "WEIXIN_CONTEXT_EXPIRED" : "WEIXIN_SEND_REJECTED";
    throw new Error(\`\${code} ret=\${ret} errcode=\${errcode}\`);
  }
}`);
  src = src.slice(0, start) + patched + src.slice(end);
  // apiPostFetch used to include the complete HTTP error body in thrown errors.
  // Limit this change to sendmessage; other API behavior is untouched.
  const httpError = 'throw new Error(`${params.label} ${res.status}: ${rawText}`);';
  const postStart = src.indexOf('export async function apiPostFetch(');
  const postEnd = functionEnd(src, postStart);
  const post = src.slice(postStart, postEnd);
  if (postStart < 0 || !post.includes(httpError)) {
    throw new Error(`${label}: expected apiPostFetch HTTP error was not found`);
  }
  const patchedPost = post.replace(httpError,
    'if (params.label === "sendMessage") throw new Error(`WEIXIN_SEND_HTTP_ERROR status=${res.status}`);\n      ' + httpError)
    .replace('logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);',
      'if (params.label !== "sendMessage") logger.debug(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);')
    .replace('logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);',
      'if (params.label !== "sendMessage") logger.debug(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);');
  src = src.slice(0, postStart) + patchedPost + src.slice(postEnd);
  fs.writeFileSync(filePath, src);
  log(`Patched ${label}: validate Weixin business receipts before reporting delivery`);
}

function patchWeixinDeliveryLog(filePath, label, log) {
  if (!fs.existsSync(filePath)) return;
  let src = fs.readFileSync(filePath, 'utf8');
  if (src.includes(DELIVERY_LOG_MARKER)) return;
  const anchor = '  void loadWeixinOutboundHooks()';
  if (!src.includes(anchor)) {
    throw new Error(`${label}: expected lazy message_sent hook was not found`);
  }
  const param = filePath.endsWith('.ts') ? 'value: string | undefined' : 'value';
  src = 'import { createHash as createWeixinDeliveryHash } from "node:crypto";\n' + src;
  src = src.replace(anchor, `  // ${DELIVERY_LOG_MARKER}: correlation without account, recipient, token or report content.
  const fingerprint = (${param}) => value
    ? createWeixinDeliveryHash("sha256").update(value).digest("hex").slice(0, 12) : "unknown";
  const safeError = params.error?.match(/WEIXIN_[A-Z_]+(?: (?:ret|errcode|status)=-?\\d+)*/)?.[0] ?? "unknown";
  const detail = \`Weixin delivery account=\${fingerprint(params.accountId)} recipient=\${fingerprint(params.to)} outcome=\${params.success ? "accepted" : "failed"}\${params.success ? "" : \` error=\${safeError}\`}\`;
  if (params.success) logger.info(detail);
  else logger.error(detail);
${anchor}`);
  fs.writeFileSync(filePath, src);
  log(`Patched ${label}: record redacted Weixin delivery outcomes`);
}

module.exports = { patchWeixinSendReceipt, patchWeixinDeliveryLog };
