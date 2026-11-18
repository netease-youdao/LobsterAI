'use strict';

const fs = require('node:fs');

const LONG_POLL_ABORT_MARKER = 'lobster_weixin_long_poll_abort_v1';

function functionEnd(source, start) {
  // A multiline parameter type also has a column-zero brace, followed by `):`.
  // Only a brace on its own line ends the pinned implementation.
  const match = /\r?\n}(?=\r?\n|$)/.exec(source.slice(start));
  return match ? start + match.index + match[0].length : -1;
}

function replaceFunction(src, signature, label, transform) {
  const start = src.indexOf(signature);
  const end = start < 0 ? -1 : functionEnd(src, start);
  if (start < 0 || end < 0) {
    throw new Error(`${label}: expected ${signature.trim()} implementation was not found`);
  }
  return src.slice(0, start) + transform(src.slice(start, end)) + src.slice(end);
}

function replaceRequired(source, from, to, label, what) {
  if (typeof from === 'string' ? !source.includes(from) : !from.test(source)) {
    throw new Error(`${label}: expected ${what} was not found`);
  }
  // Literal replacements contain template-literal `${...}` text; never expand `$` patterns.
  return typeof from === 'string' && typeof to === 'string'
    ? source.replace(from, () => to)
    : source.replace(from, to);
}

function combineAbortSignalsHelper(isTypeScript) {
  const signature = isTypeScript
    ? 'function combineAbortSignals(params: { internal?: AbortController; external?: AbortSignal }): {\n  signal?: AbortSignal;\n  cleanup: () => void;\n}'
    : 'function combineAbortSignals(params)';
  return `
// ${LONG_POLL_ABORT_MARKER}: backport of plugin 2.4.10. Channel stop aborts the
// in-flight long-poll instead of waiting up to the server long-poll timeout.
${signature} {
  const { internal, external } = params;
  if (!external) {
    return { signal: internal?.signal, cleanup: () => {} };
  }
  if (!internal) {
    return { signal: external, cleanup: () => {} };
  }
  if (external.aborted) {
    internal.abort();
    return { signal: internal.signal, cleanup: () => {} };
  }
  const onExternalAbort = () => internal.abort();
  external.addEventListener("abort", onExternalAbort, { once: true });
  return {
    signal: internal.signal,
    cleanup: () => external.removeEventListener("abort", onExternalAbort),
  };
}
`;
}

function patchApiPostFetch(fn, isTypeScript, label) {
  let patched = fn;
  if (isTypeScript) {
    patched = replaceRequired(
      patched,
      /(\n {2}label: string;\n)(\}\): Promise<string> \{)/,
      '$1  abortSignal?: AbortSignal;\n$2',
      label,
      'apiPostFetch parameter type',
    );
  }
  patched = replaceRequired(
    patched,
    /\n(\s*)try \{\n/,
    (match, indent) => `\n${indent}const { signal, cleanup } = combineAbortSignals({ internal: controller, external: params.abortSignal });${match}`,
    label,
    'apiPostFetch try block',
  );
  patched = replaceRequired(
    patched,
    '...(controller ? { signal: controller.signal } : {}),',
    '...(signal ? { signal } : {}),',
    label,
    'apiPostFetch fetch signal',
  );
  // The catch block rethrows and closes the function; append the cleanup there.
  return replaceRequired(
    patched,
    /\n(\s*)throw err;\n(\s*)\}\r?\n\}$/,
    (match, bodyIndent, closeIndent) => `\n${bodyIndent}throw err;\n${closeIndent}} finally {\n${bodyIndent}cleanup();\n${closeIndent}}\n}`,
    label,
    'apiPostFetch catch block',
  );
}

function patchGetUpdates(fn, isTypeScript, label) {
  let patched = fn;
  if (isTypeScript) {
    patched = replaceRequired(
      patched,
      /(\n(\s*)timeoutMs\?: number;\n)(\s*\},\n\): Promise<GetUpdatesResp> \{)/,
      '$1$2abortSignal?: AbortSignal;\n$3',
      label,
      'getUpdates parameter type',
    );
  }
  patched = replaceRequired(
    patched,
    /\n(\s*)label: "getUpdates",\n/,
    (match, indent) => `${match}${indent}abortSignal: params.abortSignal,\n`,
    label,
    'getUpdates request options',
  );
  return replaceRequired(
    patched,
    'logger.debug(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);',
    'logger.debug(params.abortSignal?.aborted ? "getUpdates: aborted by external signal" : `getUpdates: client-side timeout after ${timeout}ms, returning empty response`);',
    label,
    'getUpdates timeout log',
  );
}

function patchWeixinLongPollAbortApi(filePath, label, log) {
  if (!fs.existsSync(filePath)) throw new Error(`${label}: required Weixin API file was not found`);
  let src = fs.readFileSync(filePath, 'utf8');
  if (src.includes(LONG_POLL_ABORT_MARKER)) return;
  const isTypeScript = filePath.endsWith('.ts');
  src = replaceFunction(src, 'export async function apiPostFetch(', label,
    fn => `${patchApiPostFetch(fn, isTypeScript, label)}\n${combineAbortSignalsHelper(isTypeScript)}`);
  src = replaceFunction(src, 'export async function getUpdates(', label,
    fn => patchGetUpdates(fn, isTypeScript, label));
  fs.writeFileSync(filePath, src);
  log(`Patched ${label}: channel stop aborts the in-flight getUpdates long-poll`);
}

function patchWeixinLongPollAbortMonitor(filePath, label, log) {
  if (!fs.existsSync(filePath)) throw new Error(`${label}: required Weixin monitor file was not found`);
  const src = fs.readFileSync(filePath, 'utf8');
  if (src.includes(LONG_POLL_ABORT_MARKER)) return;
  const patched = replaceRequired(
    src,
    /(await getUpdates\(\{[^}]*?\n(\s*)timeoutMs: nextTimeoutMs,\n)/,
    `$1$2// ${LONG_POLL_ABORT_MARKER}: stop cancels the long-poll immediately.\n$2abortSignal,\n`,
    label,
    'monitor getUpdates call',
  );
  fs.writeFileSync(filePath, patched);
  log(`Patched ${label}: pass the channel abort signal to getUpdates`);
}

module.exports = {
  LONG_POLL_ABORT_MARKER,
  patchWeixinLongPollAbortApi,
  patchWeixinLongPollAbortMonitor,
};
