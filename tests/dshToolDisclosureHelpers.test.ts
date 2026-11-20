import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/tool-disclosure-helpers.mjs'),
).href;

type DisclosureHelpers = {
  PROGRESSIVE_CAPABILITY_IDS: readonly string[];
  resolveCapabilityForToolName: (toolName: string) => string | null;
  resolveCapabilityForSkillName: (skillName: string) => string | null;
  hasAnyProgressiveToolMounted: (toolNames: Iterable<string>) => boolean;
  normalizeCapabilityIds: (raw: unknown) => string[];
  collectAdmittedCapabilitiesFromTools: (headerTools: Array<{ name?: unknown }> | undefined) => string[];
  computeDeniedProgressiveTools: (
    restrictableNames: Iterable<string>,
    unlockedCapabilities: ReadonlySet<string>,
  ) => string[];
  listMountedToolsForCapability: (restrictableNames: Iterable<string>, capabilityId: string) => string[];
  groupMountedProgressiveTools: (restrictableNames: Iterable<string>) => Record<string, string[]>;
};

let cached: DisclosureHelpers | null = null;
async function loadHelpers(): Promise<DisclosureHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as DisclosureHelpers;
  }
  return cached;
}

describe('tool-disclosure-helpers', () => {
  test('classifies only the 5 built-in progressive MCP prefixes and leaves custom MCP & built-ins ungated', async () => {
    const h = await loadHelpers();

    expect(h.resolveCapabilityForToolName('mcp__computer-use__desktop_click')).toBe('computer-use');
    expect(h.resolveCapabilityForToolName('mcp__lobster-browser__browser_navigate')).toBe('browser');
    expect(h.resolveCapabilityForToolName('mcp__lobster-word__word_edit')).toBe('word');
    expect(h.resolveCapabilityForToolName('mcp__lobster-excel__excel_read')).toBe('excel');
    expect(h.resolveCapabilityForToolName('mcp__lobster-ppt__ppt_add_slide')).toBe('ppt');

    // DSH built-ins, host tools, and user-installed custom MCP servers must NOT be gated.
    expect(h.resolveCapabilityForToolName('bash')).toBeNull();
    expect(h.resolveCapabilityForToolName('lobster_schedule')).toBeNull();
    expect(h.resolveCapabilityForToolName('lobster_enable_tools')).toBeNull();
    expect(h.resolveCapabilityForToolName('mcp__github__list_issues')).toBeNull();
    expect(h.resolveCapabilityForToolName('mcp__my-custom-db__query')).toBeNull();
  });

  test('maps matching skill names to their capability group', async () => {
    const h = await loadHelpers();

    expect(h.resolveCapabilityForSkillName('docx')).toBe('word');
    expect(h.resolveCapabilityForSkillName('XLSX')).toBe('excel');
    expect(h.resolveCapabilityForSkillName(' pptx ')).toBe('ppt');
    expect(h.resolveCapabilityForSkillName('computer-use')).toBe('computer-use');
    expect(h.resolveCapabilityForSkillName('web-search')).toBe('browser');
    expect(h.resolveCapabilityForSkillName('article-writer')).toBeNull();
  });

  test('computes deterministic deny list and lifts unlocked groups cleanly', async () => {
    const h = await loadHelpers();

    const mounted = [
      'read',
      'bash',
      'lobster_schedule',
      'mcp__custom-crm__search',
      'mcp__lobster-word__word_write',
      'mcp__lobster-word__word_read',
      'mcp__lobster-browser__navigate',
      'mcp__computer-use__screenshot',
    ];

    expect(h.hasAnyProgressiveToolMounted(mounted)).toBe(true);
    expect(h.hasAnyProgressiveToolMounted(['read', 'bash', 'mcp__custom-crm__search'])).toBe(false);

    // Nothing unlocked yet: all built-in progressive MCP tools are denied, custom MCP stays visible.
    expect(h.computeDeniedProgressiveTools(mounted, new Set())).toEqual([
      'mcp__computer-use__screenshot',
      'mcp__lobster-browser__navigate',
      'mcp__lobster-word__word_read',
      'mcp__lobster-word__word_write',
    ]);

    // Unlock word: word tools are admitted, others remain denied.
    expect(h.computeDeniedProgressiveTools(mounted, new Set(['word']))).toEqual([
      'mcp__computer-use__screenshot',
      'mcp__lobster-browser__navigate',
    ]);

    expect(h.listMountedToolsForCapability(mounted, 'word')).toEqual([
      'mcp__lobster-word__word_read',
      'mcp__lobster-word__word_write',
    ]);
    expect(h.groupMountedProgressiveTools(mounted)).toEqual({
      word: ['mcp__lobster-word__word_read', 'mcp__lobster-word__word_write'],
      browser: ['mcp__lobster-browser__navigate'],
      'computer-use': ['mcp__computer-use__screenshot'],
    });
  });

  test('normalizes capability IDs and recovers admitted capabilities from resumed session headers', async () => {
    const h = await loadHelpers();

    expect(h.normalizeCapabilityIds(['WORD', 'word', 'invalid', 123, ' ppt '])).toEqual(['word', 'ppt']);

    const admitted = h.collectAdmittedCapabilitiesFromTools([
      { name: 'read' },
      { name: 'mcp__lobster-excel__read_range' },
      { name: 'mcp__custom-server__ping' },
      { name: 'mcp__lobster-browser__click' },
      { name: 'mcp__lobster-excel__write_cell' },
    ]);
    expect(admitted.sort()).toEqual(['browser', 'excel']);
  });
});
