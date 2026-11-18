import { describe, expect, test } from 'vitest';

import { escapeOpenClawEnvTemplate, escapeOpenClawEnvTemplateRecord } from './openclawEnvTemplate';

/**
 * Mirror of OpenClaw's `substituteString` (src/config/env-substitution.ts in the
 * pinned runtime), with every variable defined so any unescaped `${VAR}` shows.
 */
function openClawSubstitute(value: string, env: Record<string, string>): string {
  const namePattern = /^[A-Z_][A-Z0-9_]*$/;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '$') {
      out += value[i];
      continue;
    }
    if (value[i + 1] === '$' && value[i + 2] === '{') {
      const end = value.indexOf('}', i + 3);
      const name = end === -1 ? '' : value.slice(i + 3, end);
      if (namePattern.test(name)) {
        out += `\${${name}}`;
        i = end;
        continue;
      }
    }
    if (value[i + 1] === '{') {
      const end = value.indexOf('}', i + 2);
      const name = end === -1 ? '' : value.slice(i + 2, end);
      if (namePattern.test(name)) {
        out += env[name] ?? `<${name}>`;
        i = end;
        continue;
      }
    }
    out += '$';
  }
  return out;
}

const SECRET_ENV = { LOBSTER_APIKEY_SERVER: 'sk-secret', OPENCLAW_GATEWAY_TOKEN: 'gw-token' };

describe('escapeOpenClawEnvTemplate', () => {
  test('leaves values without placeholders untouched', () => {
    for (const value of ['', 'plain', 'Bearer abc', 'price $5', '$HOME', '${lower}', '${A-B}', '${UNCLOSED']) {
      expect(escapeOpenClawEnvTemplate(value)).toBe(value);
    }
  });

  test('escapes OpenClaw env placeholders', () => {
    expect(escapeOpenClawEnvTemplate('Bearer ${LOBSTER_APIKEY_SERVER}')).toBe('Bearer $${LOBSTER_APIKEY_SERVER}');
    expect(escapeOpenClawEnvTemplate('${A}${B}')).toBe('$${A}$${B}');
  });

  test.each([
    '${LOBSTER_APIKEY_SERVER}',
    'Bearer ${OPENCLAW_GATEWAY_TOKEN}',
    'https://x.example/mcp?ak=${LOBSTER_APIKEY_SERVER}&v=1',
    '$${LOBSTER_APIKEY_SERVER}',
    '$$${OPENCLAW_GATEWAY_TOKEN}',
    '${lower} ${UPPER} ${MIXED_case}',
    '${A${B}}',
    '$',
    '$$',
    'end$',
    '${',
  ])('OpenClaw loads %j back unchanged', (value) => {
    expect(openClawSubstitute(escapeOpenClawEnvTemplate(value), SECRET_ENV)).toBe(value);
  });

  test('without escaping, the gateway env would leak into the value', () => {
    expect(openClawSubstitute('Bearer ${LOBSTER_APIKEY_SERVER}', SECRET_ENV)).toBe('Bearer sk-secret');
  });

  test('escapes every value of a record and keeps the keys', () => {
    expect(escapeOpenClawEnvTemplateRecord({ AUTH: '${OPENCLAW_GATEWAY_TOKEN}', PLAIN: 'x' })).toEqual({
      AUTH: '$${OPENCLAW_GATEWAY_TOKEN}',
      PLAIN: 'x',
    });
  });
});
