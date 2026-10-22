import { describe, expect, test } from 'vitest';

import { McpAuthMode } from './auth';
import {
  buildMcpConnectorCredentials,
  getInitialMcpTokenValues,
  McpConnectorBuildError,
  type McpMarketplaceConnector,
  McpTokenFieldType,
  McpTokenValueError,
  parseMcpMarketplaceConnector,
} from './marketplace';

const tokenField = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  label: key,
  type: McpTokenFieldType.Password,
  required: true,
  ...overrides,
});

const parse = (raw: Record<string, unknown>, transportType = 'http') =>
  parseMcpMarketplaceConnector(raw, transportType);

const expectConnector = (raw: Record<string, unknown>, transportType = 'http'): McpMarketplaceConnector => {
  const result = parse(raw, transportType);
  if (!result.ok) throw new Error(result.error);
  if (!result.connector) throw new Error('expected a connector');
  return result.connector;
};

const expectRejected = (raw: Record<string, unknown>, pattern: RegExp, transportType = 'http') => {
  const result = parse(raw, transportType);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(pattern);
};

describe('parseMcpMarketplaceConnector', () => {
  test('leaves plain stdio entries alone', () => {
    expect(parse({ command: 'npx', defaultArgs: ['-y', 'pkg'] }, 'stdio')).toEqual({ ok: true, connector: undefined });
  });

  test('accepts a header-bound token connector', () => {
    const connector = expectConnector({
      url: 'https://docs.qq.com/openapi/mcp',
      tokenSchema: {
        title: '授权',
        title_en: 'Access',
        docUrl: 'https://docs.qq.com/open/auth/mcp.html',
        fields: [tokenField('TENCENT_DOCS_TOKEN', { label: '令牌', label_en: 'Token', placeholder: '粘贴令牌' })],
      },
      tokenAuth: { headers: { Authorization: { field: 'TENCENT_DOCS_TOKEN' } } },
    });
    expect(connector.url).toBe('https://docs.qq.com/openapi/mcp');
    expect(connector.tokenSchema?.fields[0]).toMatchObject({
      key: 'TENCENT_DOCS_TOKEN',
      label: '令牌',
      label_en: 'Token',
      type: McpTokenFieldType.Password,
      required: true,
    });
    expect(connector.tokenAuth).toEqual({ headers: { Authorization: { field: 'TENCENT_DOCS_TOKEN' } } });
  });

  test('accepts a URL template and an OAuth connector', () => {
    expect(expectConnector({
      url: 'https://mcp.map.baidu.com/mcp?ak=${BAIDU_MAP_AK}',
      tokenSchema: { fields: [tokenField('BAIDU_MAP_AK')] },
    }).url).toBe('https://mcp.map.baidu.com/mcp?ak=${BAIDU_MAP_AK}');
    expect(expectConnector({ url: 'https://mcp.notion.com/mcp', auth: 'oauth' }).auth).toBe(McpAuthMode.OAuth);
  });

  test('accepts a url field that is the whole endpoint', () => {
    const connector = expectConnector({
      url: '${BASE_URL}/mcp',
      tokenSchema: { fields: [tokenField('BASE_URL', { type: McpTokenFieldType.Url })] },
    });
    expect(connector.tokenSchema?.fields[0].type).toBe(McpTokenFieldType.Url);
  });

  test('passes tool allowlist, timeouts and examples through, also for stdio', () => {
    const connector = expectConnector({
      allowedTools: [' search ', '', 'read_*'],
      requestTimeoutMs: 60000,
      connectionTimeoutMs: 5000,
      examples_zh: ['帮我查一下', 42],
      examples_en: [],
    }, 'stdio');
    expect(connector).toEqual({
      allowedTools: ['search', 'read_*'],
      requestTimeoutMs: 60000,
      connectionTimeoutMs: 5000,
      examples_zh: ['帮我查一下'],
      examples_en: undefined,
    });
  });

  test.each([
    ['a malformed placeholder', { url: 'https://x.example/mcp?k=${lower-case}', tokenSchema: { fields: [tokenField('K')] } }, /malformed/],
    ['an unclosed placeholder', { url: 'https://x.example/mcp?k=${K', tokenSchema: { fields: [tokenField('K')] } }, /malformed/],
    ['an unknown placeholder', { url: 'https://x.example/mcp?k=${OTHER}', tokenSchema: { fields: [tokenField('K')] } }, /unknown field "OTHER"/],
    ['a non-http URL', { url: 'ftp://x.example/mcp' }, /http\(s\)/],
    ['a remote entry without URL', { auth: 'oauth' }, /need a url/],
    ['an unsupported auth mode', { url: 'https://x.example/mcp', auth: 'basic' }, /auth must be/],
    ['OAuth with a credential form', { url: 'https://x.example/mcp', auth: 'oauth', tokenSchema: { fields: [tokenField('K')] }, tokenAuth: { headers: { 'X-Key': { field: 'K' } } } }, /OAuth entries/],
    ['tokenAuth without a schema', { url: 'https://x.example/mcp', tokenAuth: { headers: { Authorization: { field: 'K' } } } }, /needs a tokenSchema/],
    ['a header bound to a missing field', { url: 'https://x.example/mcp', tokenSchema: { fields: [tokenField('K')] }, tokenAuth: { headers: { Authorization: { field: 'NOPE' } } } }, /unknown field "NOPE"/],
    ['a field nothing uses', { url: 'https://x.example/mcp', tokenSchema: { fields: [tokenField('K')] } }, /not used/],
    ['a duplicate field key', { url: 'https://x.example/mcp?a=${K}', tokenSchema: { fields: [tokenField('K'), tokenField('K')] } }, /declared twice/],
    ['a field key that is not an identifier', { url: 'https://x.example/mcp', tokenSchema: { fields: [tokenField('my-key')] } }, /identifier/],
    ['an unknown field type', { url: 'https://x.example/mcp?a=${K}', tokenSchema: { fields: [tokenField('K', { type: 'number' })] } }, /unsupported type/],
    ['a non-http doc link', { url: 'https://x.example/mcp?a=${K}', tokenSchema: { docUrl: 'javascript:alert(1)', fields: [tokenField('K')] } }, /docUrl/],
    ['a non-positive timeout', { url: 'https://x.example/mcp', requestTimeoutMs: 0 }, /requestTimeoutMs/],
    ['a non-numeric timeout', { url: 'https://x.example/mcp', connectionTimeoutMs: '5000' }, /connectionTimeoutMs/],
    ['allowedTools that are not strings', { url: 'https://x.example/mcp', allowedTools: [1] }, /allowedTools/],
  ])('rejects %s', (_name, raw, pattern) => {
    expectRejected(raw as Record<string, unknown>, pattern);
  });

  test('rejects connector fields on a stdio entry', () => {
    expectRejected({ url: 'https://x.example/mcp' }, /sse or http/, 'stdio');
  });

  describe('tokenAuth header validation', () => {
    const withHeader = (headers: Record<string, unknown>) => ({
      url: 'https://x.example/mcp',
      tokenSchema: { fields: [tokenField('K')] },
      tokenAuth: { headers },
    });

    test.each(['Host', 'content-length', 'Connection', 'Transfer-Encoding'])('rejects the %s header', (name) => {
      expectRejected(withHeader({ [name]: { field: 'K' } }), /not allowed/);
    });

    test.each(['Bad Header', 'X-Key:', ''])('rejects the header name %j', (name) => {
      expectRejected(withHeader({ [name]: { field: 'K' } }), /not a valid header name/);
    });

    test.each(['Bearer\r\n', 'Bearer\n', 'Bear\0er'])('rejects a prefix with CR, LF or NUL (%j)', (prefix) => {
      expectRejected(withHeader({ Authorization: { field: 'K', prefix } }), /CR, LF or NUL/);
    });

    test('rejects the same header twice in different case', () => {
      expectRejected(withHeader({ Authorization: { field: 'K' }, authorization: { field: 'K' } }), /declared twice/);
    });

    test('keeps a valid prefix', () => {
      expect(expectConnector(withHeader({ Authorization: { field: 'K', prefix: 'Bearer ' } })).tokenAuth)
        .toEqual({ headers: { Authorization: { field: 'K', prefix: 'Bearer ' } } });
    });
  });
});

describe('buildMcpConnectorCredentials', () => {
  const headerConnector = expectConnector({
    url: 'https://docs.qq.com/openapi/mcp',
    tokenSchema: {
      fields: [
        tokenField('TOKEN'),
        tokenField('TENANT', { type: McpTokenFieldType.Text, required: false }),
      ],
    },
    tokenAuth: {
      headers: {
        Authorization: { field: 'TOKEN', prefix: 'Bearer ' },
        'X-Tenant': { field: 'TENANT' },
      },
    },
  });

  test('binds headers with their prefix and leaves out empty optional ones', () => {
    expect(buildMcpConnectorCredentials(headerConnector, { TOKEN: '  abc123  ', TENANT: '' })).toEqual({
      ok: true,
      url: 'https://docs.qq.com/openapi/mcp',
      headers: { Authorization: 'Bearer abc123' },
      tokenValues: { TOKEN: 'abc123', TENANT: '' },
    });
  });

  test('reports missing required values and line breaks per field', () => {
    expect(buildMcpConnectorCredentials(headerConnector, { TOKEN: '', TENANT: 'a\r\nX-Evil: 1' })).toEqual({
      ok: false,
      code: McpConnectorBuildError.InvalidFields,
      fieldErrors: {
        TOKEN: McpTokenValueError.Required,
        TENANT: McpTokenValueError.InvalidCharacters,
      },
    });
  });

  test('percent-encodes values substituted into the URL', () => {
    const connector = expectConnector({
      url: 'https://mcp.map.baidu.com/mcp?ak=${AK}&region=${REGION}',
      tokenSchema: { fields: [tokenField('AK'), tokenField('REGION', { type: 'text', required: false })] },
    });
    const result = buildMcpConnectorCredentials(connector, { AK: 'a&b=c#d', REGION: '' });
    expect(result).toMatchObject({ ok: true, url: 'https://mcp.map.baidu.com/mcp?ak=a%26b%3Dc%23d&region=', headers: {} });
  });

  test('keeps a user value that looks like a placeholder literal', () => {
    const connector = expectConnector({
      url: 'https://x.example/mcp?key=${KEY}',
      tokenSchema: { fields: [tokenField('KEY')] },
      tokenAuth: { headers: { 'X-Key': { field: 'KEY' } } },
    });
    const result = buildMcpConnectorCredentials(connector, { KEY: '${LOBSTER_APIKEY_SERVER}' });
    expect(result).toMatchObject({
      ok: true,
      url: 'https://x.example/mcp?key=%24%7BLOBSTER_APIKEY_SERVER%7D',
      headers: { 'X-Key': '${LOBSTER_APIKEY_SERVER}' },
    });
  });

  test('substitutes url fields unencoded and validates them', () => {
    const connector = expectConnector({
      url: '${BASE_URL}/mcp',
      tokenSchema: { fields: [tokenField('BASE_URL', { type: McpTokenFieldType.Url })] },
    });
    expect(buildMcpConnectorCredentials(connector, { BASE_URL: 'https://mcp.example.com' }))
      .toMatchObject({ ok: true, url: 'https://mcp.example.com/mcp' });
    expect(buildMcpConnectorCredentials(connector, { BASE_URL: 'not a url' })).toEqual({
      ok: false,
      code: McpConnectorBuildError.InvalidFields,
      fieldErrors: { BASE_URL: McpTokenValueError.InvalidUrl },
    });
  });

  test('refuses a template with a stray placeholder', () => {
    const broken: McpMarketplaceConnector = { url: 'https://x.example/mcp?k=${K' };
    expect(buildMcpConnectorCredentials(broken, {})).toEqual({
      ok: false,
      code: McpConnectorBuildError.InvalidUrl,
      fieldErrors: {},
    });
  });

  test('starts the form from saved values, then defaults', () => {
    const schema = expectConnector({
      url: 'https://x.example/mcp?a=${A}&b=${B}',
      tokenSchema: { fields: [tokenField('A', { defaultValue: 'fallback' }), tokenField('B')] },
    }).tokenSchema!;
    expect(getInitialMcpTokenValues(schema)).toEqual({ A: 'fallback', B: '' });
    expect(getInitialMcpTokenValues(schema, { A: 'saved', B: 'kept' })).toEqual({ A: 'saved', B: 'kept' });
  });
});
