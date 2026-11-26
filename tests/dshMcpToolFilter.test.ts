import { createHash } from 'crypto';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const FILTER_HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/mcp-tool-filter-helpers.mjs'),
).href;
const DISCLOSURE_HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/tool-disclosure-helpers.mjs'),
).href;

type McpFilterSpec = {
  include?: readonly string[];
  exclude?: readonly string[];
};

type McpToolFilterHelpers = {
  publicMcpToolName: (serverName: string, rawName: string) => string;
  normalizeMcpToolFilter: (filter: unknown) => McpFilterSpec | undefined;
  matchesMcpToolPattern: (pattern: string, value: string) => boolean;
  isPublicMcpToolAllowed: (
    serverName: string,
    publicName: string,
    filter: McpFilterSpec | undefined,
  ) => boolean;
  resolveMcpServerOwner: (
    toolName: string,
    mcpToolFilters: ReadonlyMap<string, McpFilterSpec> | undefined,
    registeredServerNames?: Iterable<string>,
  ) => string | null;
  isUserMcpToolDenied: (
    toolName: string,
    mcpToolFilters: ReadonlyMap<string, McpFilterSpec> | undefined,
    registeredServerNames?: Iterable<string>,
  ) => boolean;
  computeDeniedUserMcpTools: (
    restrictableNames: Iterable<string>,
    mcpToolFilters: ReadonlyMap<string, McpFilterSpec> | undefined,
    registeredServerNames?: Iterable<string>,
  ) => string[];
};

type DisclosureHelpers = {
  PROGRESSIVE_CAPABILITY_IDS: readonly string[];
  computeCombinedDeniedTools: (
    restrictableNames: Iterable<string>,
    unlockedCapabilities: ReadonlySet<string>,
    mcpToolFilters: ReadonlyMap<string, McpFilterSpec> | undefined,
    registeredServerNames?: Iterable<string>,
  ) => string[];
};

let cachedFilter: McpToolFilterHelpers | null = null;
let cachedDisclosure: DisclosureHelpers | null = null;

async function loadFilterHelpers(): Promise<McpToolFilterHelpers> {
  if (!cachedFilter) {
    cachedFilter = (await import(FILTER_HELPERS_URL)) as McpToolFilterHelpers;
  }
  return cachedFilter;
}

async function loadDisclosureHelpers(): Promise<DisclosureHelpers> {
  if (!cachedDisclosure) {
    cachedDisclosure = (await import(DISCLOSURE_HELPERS_URL)) as DisclosureHelpers;
  }
  return cachedDisclosure;
}

function expectedDshPublicName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12);
  return `${normalized.slice(0, 51)}_${hash}`;
}

describe('mcp-tool-filter-helpers', () => {
  test('publicMcpToolName matches @deepseek-ai/dsh-mcp-client naming and hashing rules exactly', async () => {
    const h = await loadFilterHelpers();

    // Clean short name: verbatim
    expect(h.publicMcpToolName('filter-demo', 'allowed_echo')).toBe('mcp__filter-demo__allowed_echo');

    // Clean name at exact 64-char boundary: verbatim
    const exact64Raw = 'a'.repeat(64 - 'mcp__srv__'.length);
    expect(h.publicMcpToolName('srv', exact64Raw)).toBe(`mcp__srv__${exact64Raw}`);
    expect(h.publicMcpToolName('srv', exact64Raw)).toHaveLength(64);

    // Clean name at 65 chars: truncated to 51 + '_' + 12-hex hash (total 64)
    const over64Raw = 'a'.repeat(65 - 'mcp__srv__'.length);
    expect(h.publicMcpToolName('srv', over64Raw)).toBe(expectedDshPublicName('srv', over64Raw));
    expect(h.publicMcpToolName('srv', over64Raw)).toHaveLength(64);

    // Dotted short name: normalized + '_' + 12-hex hash (not padded to 51)
    expect(h.publicMcpToolName('docs', 'doc.get')).toBe(expectedDshPublicName('docs', 'doc.get'));
    expect(h.publicMcpToolName('docs', 'doc.get')).toMatch(/^mcp__docs__doc_get_[0-9a-f]{12}$/);

    // Long dotted >64-char name
    const longDotted = 'very.long.dotted.tool.name.exceeding.sixty.four.characters.for.hash.check';
    const longPublic = h.publicMcpToolName('filter-demo', longDotted);
    expect(longPublic).toBe(expectedDshPublicName('filter-demo', longDotted));
    expect(longPublic).toHaveLength(64);

    // Two >64-char names sharing the same 51-char prefix produce distinct hashes
    const longDottedOther = 'very.long.dotted.tool.name.exceeding.sixty.four.characters.for.hash.other';
    expect(h.publicMcpToolName('filter-demo', longDottedOther)).not.toBe(longPublic);
  });

  test('normalizeMcpToolFilter trims, deduplicates, drops blanks, and freezes non-empty filters', async () => {
    const h = await loadFilterHelpers();

    expect(h.normalizeMcpToolFilter(undefined)).toBeUndefined();
    expect(h.normalizeMcpToolFilter(null)).toBeUndefined();
    expect(h.normalizeMcpToolFilter({})).toBeUndefined();
    expect(h.normalizeMcpToolFilter({ include: ['', '  '], exclude: [] })).toBeUndefined();

    const normalized = h.normalizeMcpToolFilter({
      include: [' allowed_echo ', 'allowed_echo', '', null, 'sheet.*'],
      exclude: [' blocked_secret ', 'blocked_secret'],
    });
    expect(normalized).toEqual({
      include: ['allowed_echo', 'sheet.*'],
      exclude: ['blocked_secret'],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized?.include)).toBe(true);
    expect(Object.isFrozen(normalized?.exclude)).toBe(true);
  });

  test('supports include-only, exclude-only, combined include+exclude, and * globs', async () => {
    const h = await loadFilterHelpers();
    const srv = 'demo';
    const tools = [
      'search_issues',
      'search_prs',
      'create_issue',
      'delete_repo',
      'get_me',
    ].map((raw) => h.publicMcpToolName(srv, raw));

    // Include-only (exact + glob)
    const includeOnly = new Map([[srv, h.normalizeMcpToolFilter({ include: ['search_*', 'get_me'] })!]]);
    expect(h.computeDeniedUserMcpTools(tools, includeOnly)).toEqual([
      'mcp__demo__create_issue',
      'mcp__demo__delete_repo',
    ]);

    // Exclude-only (McpToolPicker shape)
    const excludeOnly = new Map([[srv, h.normalizeMcpToolFilter({ exclude: ['delete_repo', 'create_issue'] })!]]);
    expect(h.computeDeniedUserMcpTools(tools, excludeOnly)).toEqual([
      'mcp__demo__create_issue',
      'mcp__demo__delete_repo',
    ]);

    // Combined include + exclude (exclude overrides include)
    const combined = new Map([[srv, h.normalizeMcpToolFilter({
      include: ['search_*', 'create_issue'],
      exclude: ['search_prs', '*_issue'],
    })!]]);
    expect(h.computeDeniedUserMcpTools(tools, combined)).toEqual([
      'mcp__demo__create_issue',
      'mcp__demo__delete_repo',
      'mcp__demo__get_me',
      'mcp__demo__search_prs',
    ]);

    // Wildcard '*' with exclude
    const starWithExclude = new Map([[srv, h.normalizeMcpToolFilter({
      include: ['*'],
      exclude: ['*_repo'],
    })!]]);
    expect(h.computeDeniedUserMcpTools(tools, starWithExclude)).toEqual([
      'mcp__demo__delete_repo',
    ]);
  });

  test('filters dotted and >64-char hashed tool names accurately for both exact patterns and globs', async () => {
    const h = await loadFilterHelpers();
    const srv = 'filter-demo';

    const rawLongA = 'very.long.dotted.tool.name.exceeding.sixty.four.characters.for.hash.check';
    const rawLongB = 'very.long.dotted.tool.name.exceeding.sixty.four.characters.for.hash.other';
    const rawCleanLong = 'a_very_long_clean_tool_name_exceeding_sixty_four_characters_in_length';
    const rawDottedGet = 'doc.get';
    const rawCleanGet = 'doc_get';
    const rawSheetRead = 'sheet.read';
    const rawEcho = 'allowed_echo';

    const pubLongA = h.publicMcpToolName(srv, rawLongA);
    const pubLongB = h.publicMcpToolName(srv, rawLongB);
    const pubCleanLong = h.publicMcpToolName(srv, rawCleanLong);
    const pubDottedGet = h.publicMcpToolName(srv, rawDottedGet);
    const pubCleanGet = h.publicMcpToolName(srv, rawCleanGet);
    const pubSheetRead = h.publicMcpToolName(srv, rawSheetRead);
    const pubEcho = h.publicMcpToolName(srv, rawEcho);

    const allTools = [pubLongA, pubLongB, pubCleanLong, pubDottedGet, pubCleanGet, pubSheetRead, pubEcho];

    // Exact exclude of >64-char dotted name: ONLY rawLongA is denied, colliding rawLongB remains allowed!
    const exactExcludeLong = new Map([[srv, h.normalizeMcpToolFilter({ exclude: [rawLongA] })!]]);
    expect(h.computeDeniedUserMcpTools(allTools, exactExcludeLong)).toEqual([pubLongA]);

    // Exact include of >64-char dotted + >64-char clean + dotted short:
    // rawDottedGet (`doc.get`) matches ONLY pubDottedGet, NOT pubCleanGet (`doc_get`)!
    const exactInclude = new Map([[srv, h.normalizeMcpToolFilter({
      include: [rawLongA, rawCleanLong, rawDottedGet],
    })!]]);
    expect(h.computeDeniedUserMcpTools(allTools, exactInclude)).toEqual(
      [pubLongB, pubCleanGet, pubSheetRead, pubEcho].sort(),
    );

    // Exact exclude of clean `doc_get` must NOT deny hashed `doc.get`
    const excludeCleanGet = new Map([[srv, h.normalizeMcpToolFilter({ exclude: [rawCleanGet] })!]]);
    expect(h.computeDeniedUserMcpTools([pubDottedGet, pubCleanGet], excludeCleanGet)).toEqual([pubCleanGet]);

    // Dotted glob `sheet.*` matches hashed `sheet.read` and `doc.*` matches hashed `doc.get` without matching clean `doc_get`
    const dottedGlobInclude = new Map([[srv, h.normalizeMcpToolFilter({
      include: ['doc.*', 'sheet.*', 'very.long.*'],
    })!]]);
    expect(h.isUserMcpToolDenied(pubDottedGet, dottedGlobInclude)).toBe(false);
    expect(h.isUserMcpToolDenied(pubSheetRead, dottedGlobInclude)).toBe(false);
    expect(h.isUserMcpToolDenied(pubLongA, dottedGlobInclude)).toBe(false);
    expect(h.isUserMcpToolDenied(pubLongB, dottedGlobInclude)).toBe(false);
    expect(h.isUserMcpToolDenied(pubCleanGet, dottedGlobInclude)).toBe(true);
    expect(h.isUserMcpToolDenied(pubEcho, dottedGlobInclude)).toBe(true);
  });

  test('disambiguates server prefixes and leaves unrelated servers and built-in tools untouched', async () => {
    const h = await loadFilterHelpers();
    const filters = new Map([
      ['foo', h.normalizeMcpToolFilter({ include: ['allowed'] })!],
    ]);
    const registered = new Set(['foo', 'foo__bar', 'other']);

    expect(h.isUserMcpToolDenied('bash', filters, registered)).toBe(false);
    expect(h.isUserMcpToolDenied('read', filters, registered)).toBe(false);
    expect(h.isUserMcpToolDenied('mcp__other__anything', filters, registered)).toBe(false);
    // Owned by `foo__bar` (no filter), must NOT be caught by `foo`'s include filter.
    expect(h.isUserMcpToolDenied('mcp__foo__bar__baz', filters, registered)).toBe(false);
    // Owned by `foo` (filtered).
    expect(h.isUserMcpToolDenied('mcp__foo__allowed', filters, registered)).toBe(false);
    expect(h.isUserMcpToolDenied('mcp__foo__blocked', filters, registered)).toBe(true);
  });

  test('progressive unlock immunity: user toolFilter denials survive full progressive capability unlock', async () => {
    const fh = await loadFilterHelpers();
    const dh = await loadDisclosureHelpers();

    const longRaw = 'very.long.dotted.tool.name.exceeding.sixty.four.characters.for.hash.check';
    const longPub = fh.publicMcpToolName('filter-demo', longRaw);
    const mounted = [
      'bash',
      'mcp__filter-demo__allowed_echo',
      'mcp__filter-demo__blocked_secret',
      longPub,
      'mcp__lobster-browser__navigate',
      'mcp__lobster-browser__click',
    ];
    const filters = new Map([
      ['filter-demo', fh.normalizeMcpToolFilter({ include: ['allowed_echo'], exclude: ['blocked_secret'] })!],
      ['lobster-browser', fh.normalizeMcpToolFilter({ exclude: ['click'] })!],
    ]);

    const allUnlocked = new Set(dh.PROGRESSIVE_CAPABILITY_IDS);
    expect(dh.computeCombinedDeniedTools(mounted, allUnlocked, filters)).toEqual(
      ['mcp__filter-demo__blocked_secret', longPub, 'mcp__lobster-browser__click'].sort(),
    );
  });
});
