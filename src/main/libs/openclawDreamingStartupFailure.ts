import { StringDecoder } from 'string_decoder';
import { stripVTControlCharacters } from 'util';

import { OpenClawDreamingStateLabel } from '../../shared/openclawEngine/dreamingRecovery';
import { OPENCLAW_CLI_ERROR_TYPE } from '../../shared/openclawEngine/startupCompatibility';

export const OPENCLAW_STARTUP_MIGRATION_REFUSAL =
  'OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.';
const SOURCE_FAILURE = new RegExp(`^- Skipped Memory Core (${Object.values(OpenClawDreamingStateLabel).join('|')}) import for .+ because the legacy source could not be (?:imported|compared): SyntaxError:`);
const LINE_LIMIT = 32_768;

/** One instance per stderr stream. Only details AFTER the terminal refusal count. */
export function createDreamingStartupFailureCollector() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let discardingLine = false;
  let inRefusal = false;
  let count = 0;
  const labels = new Set<string>();

  function acceptLine(raw: string) {
    const line = stripVTControlCharacters(raw).trim()
      .replace(/^(?:\[[^\]\r\n]*\]\s*)+/, '').replace(/^Reason:\s*/, '');
    if (line === OPENCLAW_STARTUP_MIGRATION_REFUSAL) {
      inRefusal = true;
      count = 0;
      labels.clear();
      return;
    }
    if (!inRefusal) return;
    const match = line.match(SOURCE_FAILURE);
    if (match) {
      count++;
      labels.add(match[1]);
    }
    if (line && !line.startsWith('- ')) inRefusal = false;
  }

  function acceptText(text: string) {
    pending += text;
    let boundary: number;
    while ((boundary = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (!discardingLine && line.length <= LINE_LIMIT) acceptLine(line);
      discardingLine = false;
    }
    if (pending.length > LINE_LIMIT) {
      pending = '';
      discardingLine = true;
      inRefusal = false;
    }
  }

  return {
    write(chunk: Buffer | string) {
      acceptText(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    finish(): string | undefined {
      acceptText(decoder.end());
      if (pending && !discardingLine) acceptLine(pending);
      pending = '';
      // Keep raw JSON parser errors (which can quote memory contents) out of UI/status.
      return count > 0
        ? `${OPENCLAW_STARTUP_MIGRATION_REFUSAL}\nMemory Core legacy JSON could not be parsed: ${[...labels].join(', ')} (${count} source(s)).`
        : undefined;
    },
  };
}

/** Called on complete CLI output, before presentation truncates the failure. */
export function extractDreamingStartupFailure(stdout: string, stderr: string): string | undefined {
  // JSON mode's actual CLI cause takes precedence over diagnostic stderr.
  for (const candidate of [stdout.trim(), ...stdout.split(/\r?\n/).reverse()]) {
    try {
      const envelope = JSON.parse(candidate);
      if (envelope?.ok === false && envelope.error?.type === OPENCLAW_CLI_ERROR_TYPE && typeof envelope.error.message === 'string') {
        const structured = createDreamingStartupFailureCollector();
        structured.write(envelope.error.message);
        return structured.finish();
      }
    } catch { /* Diagnostic output is not a CLI error envelope. */ }
  }
  const collector = createDreamingStartupFailureCollector();
  collector.write(stderr);
  return collector.finish();
}
