import { formatWithOptions, stripVTControlCharacters } from 'node:util';

export const name = 'lobster-log-forwarder';

const MAX_LINE_BYTES = 2048;
const encoder = new TextEncoder();
const inspectOptions = {
  colors: false, customInspect: false, depth: 3, maxArrayLength: 16, maxStringLength: MAX_LINE_BYTES,
};
const placeholders = { '%C': '%s', '%j': '%O', '%%': '%%' };
// Suppress the whole field so quoted, multiline and nested credentials cannot spill past a mask.
const credentialField = /(?:token|api[-_ ]?key|secret|passw(?:or)?d|authorization|cookie|private[-_ ]?key)[\\"']*\s*[:=]|--(?:token|password|client-secret)\s+\S/i;
const credentialValue = /\b(?:bearer|basic|api[-_ ]?key)\s+\S|\b(?:sk|rk)-[a-z\d_-]{8,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+|:\/\/[^/\s@]+:[^/\s@]+@/i;

function cleanField(text) {
  const plain = stripVTControlCharacters(text).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');
  return credentialField.test(plain) || credentialValue.test(plain) ? '[redacted]' : plain;
}

function formatArgs(args) {
  const [first, ...rest] = args;
  // Node handles Error stacks and circular objects. Translate Cordis colors and use
  // bounded inspection for JSON placeholders, preserving escaped percent signs.
  const format = typeof first === 'string' && rest.length
    ? first.replace(/%[%Cj]/g, (spec) => placeholders[spec])
    : first;
  return cleanField(formatWithOptions(inspectOptions, format, ...rest));
}

function limitLine(line) {
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const { read } = encoder.encodeInto(line, Buffer.alloc(MAX_LINE_BYTES - 3));
  return line.slice(0, read) + '...';
}

export function apply(ctx) {
  // Cordis registers this exporter as an effect on the plugin's own fiber.
  ctx.logger.exporter({
    levels: { default: 2 }, // error (0), warn (1), info (2)
    colors: 0,
    export(message) {
      let body;
      try {
        body = formatArgs(message.args);
      } catch {
        body = '[unformattable log arguments]';
      }
      const source = cleanField(message.name || 'host').replace(/[[\]]/g, '_').slice(0, 96);
      process.stderr.write(limitLine(`[dsh-logger][${message.type}][${source}] ${body}`) + '\n');
    },
  });
}
