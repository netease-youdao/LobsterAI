import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/tool-disclosure-helpers.mjs'),
).href;

type DisclosureHelpers = {
  GOAL_TOOL_NAMES: readonly string[];
  PROGRESSIVE_CAPABILITY_IDS: readonly string[];
  resolveCapabilityForToolName: (toolName: string) => string | null;
  resolveCapabilityForSkillName: (skillName: string) => string | null;
  hasAdmittedGoalTools: (headerTools: Array<{ name?: unknown }> | undefined) => boolean;
  hasAnyProgressiveToolMounted: (toolNames: Iterable<string>) => boolean;
  normalizeCapabilityIds: (raw: unknown) => string[];
  collectAdmittedCapabilitiesFromTools: (headerTools: Array<{ name?: unknown }> | undefined) => string[];
  computeDeniedProgressiveTools: (
    restrictableNames: Iterable<string>,
    unlockedCapabilities: ReadonlySet<string>,
  ) => string[];
  computeCombinedDeniedTools: (
    restrictableNames: Iterable<string>,
    unlockedCapabilities: ReadonlySet<string>,
    mcpToolFilters: ReadonlyMap<string, { include?: readonly string[]; exclude?: readonly string[] }>,
    registeredServerNames?: Iterable<string>,
  ) => string[];
  listMountedToolsForCapability: (restrictableNames: Iterable<string>, capabilityId: string) => string[];
  groupMountedProgressiveTools: (restrictableNames: Iterable<string>) => Record<string, string[]>;
  renderEnableToolsOutput: (args: unknown, value: unknown) => Array<{ type: string; text: string }>;
};

let cached: DisclosureHelpers | null = null;
async function loadHelpers(): Promise<DisclosureHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as DisclosureHelpers;
  }
  return cached;
}

describe('tool-disclosure-helpers', () => {
  test('classifies built-in progressive MCP prefixes and scoped host tools while leaving custom MCP & built-ins ungated', async () => {
    const h = await loadHelpers();

    expect(h.resolveCapabilityForToolName('mcp__computer-use__desktop_click')).toBe('computer-use');
    expect(h.resolveCapabilityForToolName('mcp__lobster-browser__browser_navigate')).toBe('browser');
    expect(h.resolveCapabilityForToolName('mcp__lobster-word__word_edit')).toBe('word');
    expect(h.resolveCapabilityForToolName('mcp__lobster-excel__excel_read')).toBe('excel');
    expect(h.resolveCapabilityForToolName('mcp__lobster-ppt__ppt_add_slide')).toBe('ppt');
    expect(h.resolveCapabilityForToolName('lobsterai_render_html_to_image')).toBe('html-render');
    expect(h.resolveCapabilityForToolName('lobsterai_skin_manage')).toBe('skin-manage');

    // DSH built-ins, general host tools, and user-installed custom MCP servers must NOT be gated.
    expect(h.resolveCapabilityForToolName('bash')).toBeNull();
    expect(h.resolveCapabilityForToolName('lobster_schedule')).toBeNull();
    expect(h.resolveCapabilityForToolName('lobster_enable_tools')).toBeNull();
    expect(h.resolveCapabilityForToolName('mcp__github__list_issues')).toBeNull();
    expect(h.resolveCapabilityForToolName('mcp__my-custom-db__query')).toBeNull();

    // Goal tools detection from resumed session headers.
    expect(h.GOAL_TOOL_NAMES).toEqual(['create_goal', 'update_goal', 'get_goal']);
    expect(h.hasAdmittedGoalTools([{ name: 'read' }, { name: 'create_goal' }])).toBe(true);
    expect(h.hasAdmittedGoalTools([{ name: 'read' }, { name: 'bash' }])).toBe(false);
  });

  test('maps matching skill names to their capability group', async () => {
    const h = await loadHelpers();

    expect(h.resolveCapabilityForSkillName('docx')).toBe('word');
    expect(h.resolveCapabilityForSkillName('XLSX')).toBe('excel');
    expect(h.resolveCapabilityForSkillName(' pptx ')).toBe('ppt');
    expect(h.resolveCapabilityForSkillName('computer-use')).toBe('computer-use');
    expect(h.resolveCapabilityForSkillName('skin-creator')).toBe('skin-manage');
    expect(h.resolveCapabilityForSkillName('web-search')).toBeNull();
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

  test('combines progressive denials with user toolFilter denials and never lets unlock override user filters', async () => {
    const h = await loadHelpers();

    const mounted = [
      'bash',
      'mcp__filter-demo__allowed_echo',
      'mcp__filter-demo__blocked_secret',
      'mcp__lobster-word__word_read',
      'mcp__lobster-word__word_delete',
      'mcp__lobster-browser__navigate',
    ];
    const userFilters = new Map([
      ['filter-demo', { include: ['allowed_echo'], exclude: ['blocked_secret'] }],
      ['lobster-word', { exclude: ['word_delete'] }],
    ]);

    // Nothing unlocked: both locked progressive groups and user-filtered tools are denied.
    expect(h.computeCombinedDeniedTools(mounted, new Set(), userFilters)).toEqual([
      'mcp__filter-demo__blocked_secret',
      'mcp__lobster-browser__navigate',
      'mcp__lobster-word__word_delete',
      'mcp__lobster-word__word_read',
    ]);

    // Unlock ALL progressive capabilities: progressive tools open up EXCEPT those denied by user toolFilter!
    const allUnlocked = new Set(h.PROGRESSIVE_CAPABILITY_IDS);
    expect(h.computeCombinedDeniedTools(mounted, allUnlocked, userFilters)).toEqual([
      'mcp__filter-demo__blocked_secret',
      'mcp__lobster-word__word_delete',
    ]);
  });

  test('renders lobster_enable_tools output as DSH ContentBlock[] compatible with spill-policy', async () => {
    const h = await loadHelpers();

    const renderedText = h.renderEnableToolsOutput(
      { capabilities: ['computer-use'] },
      { ok: true, text: '- computer-use 已启用（2 个工具）\n下一步可直接调用已启用的工具。' },
    );
    expect(Array.isArray(renderedText)).toBe(true);
    expect(renderedText).toEqual([
      { type: 'text', text: '- computer-use 已启用（2 个工具）\n下一步可直接调用已启用的工具。' },
    ]);
    expect(renderedText.some((block) => block.type === 'image')).toBe(false);

    expect(h.renderEnableToolsOutput({}, { ok: false, unavailable: ['ppt'] })).toEqual([
      { type: 'text', text: JSON.stringify({ ok: false, unavailable: ['ppt'] }) },
    ]);
    expect(h.renderEnableToolsOutput({}, null)).toEqual([{ type: 'text', text: 'null' }]);
  });
});
