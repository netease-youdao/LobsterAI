import { expect, test } from 'vitest';

import { HighlightStatus, MAX_HIGHLIGHT_BYTES } from './constants';
import { codeFenceLanguage, resolveCodeLanguage } from './language';
import { CodeTokenizer, sourceLineOffsets } from './tokenizer';

test('all code surfaces resolve exact aliases, diff:typescript and filename grammars consistently', () => {
  expect(codeFenceLanguage('foo language-diff:typescript extra')).toBe('diff:typescript');
  expect(codeFenceLanguage('language-c++')).toBe('c++');
  for (const [alias, name] of [['ts', 'TypeScript'], ['py', 'Python'], ['bash', 'Shell'], ['cs', 'C#']]) expect(resolveCodeLanguage(alias)?.name).toBe(name);
  expect(resolveCodeLanguage(undefined, 'web/NewPage.tsx')?.name).toBe('TSX');
  expect(resolveCodeLanguage('nonsense')).toBeNull();
  expect(resolveCodeLanguage('java-not-a-language')).toBeNull();
});

test('complete old and new files keep independent lexical context across hidden gaps and CRLF', async () => {
  const engine = new CodeTokenizer();
  const oldSource = ['/* before first hunk', 'old comment', 'hidden context', 'const value = 1;', '*/', 'const name = "old";'].join('\r\n');
  const newSource = ['// before first hunk', 'const value = 2;', 'const template = `hello', 'const value = 3;', 'world`;', 'const name = "new";'].join('\r\n');
  const [old, next] = await Promise.all([
    engine.highlight({ id: 1, identity: 's:a:v1:f:old', path: 'old.ts', source: oldSource, lines: [2, 4, 6] }),
    engine.highlight({ id: 2, identity: 's:a:v1:f:new', path: 'new.ts', source: newSource, lines: [2, 4, 6] }),
  ]);
  expect(old.status).toBe(HighlightStatus.Ready); expect(next.status).toBe(HighlightStatus.Ready);
  expect(old.lines.map(line => line.number)).toEqual([2, 4, 6]);
  expect(old.lines[1].tokens).toEqual([{ from: 0, to: 16, className: 'tok-comment' }]);
  expect(next.lines[1].tokens).toEqual([{ from: 0, to: 16, className: 'tok-string' }]);
  expect(next.lines[0].tokens.some(token => token.className === 'tok-keyword')).toBe(true);
  expect(sourceLineOffsets('a\r\nb\n')).toEqual({ starts: [0, 3, 5], ends: [1, 4, 5] });
});

test('HTML mixed parser highlights embedded CSS and JavaScript without treating HTML as executable', async () => {
  const source = '<style>\nbody { color: red; }\n</style>\n<script>\nconst text = "<img src=x onerror=alert(1)>";\n</script>';
  const result = await new CodeTokenizer().highlight({ id: 1, identity: 'html', path: 'page.html', source, lines: [2, 5] });
  expect(result.status).toBe(HighlightStatus.Ready);
  expect(result.lines[0].tokens.length).toBeGreaterThan(2);
  expect(result.lines[1].tokens.some(token => token.className === 'tok-keyword')).toBe(true);
  expect(result.lines[1].tokens.some(token => token.className === 'tok-string')).toBe(true);
  expect(result.lines).toHaveLength(2);
});

test('Markdown full-source parsing loads fenced grammars before returning worker tokens', async () => {
  const result = await new CodeTokenizer().highlight({ id: 1, identity: 'markdown', path: 'README.md', source: '# Example\n```py\ndef hello():\n    return "hi"\n```', lines: [1, 3, 4] });
  expect(result.status).toBe(HighlightStatus.Ready);
  expect(result.lines[0].tokens.some(token => token.className.split(' ').includes('tok-heading'))).toBe(true);
  expect(result.lines[0].tokens.some(token => token.className.split(' ').includes('tok-name'))).toBe(false);
  expect(result.lines[1].tokens.some(token => token.className === 'tok-keyword')).toBe(true);
  expect(result.lines[2].tokens.some(token => token.className === 'tok-string')).toBe(true);
});

test('bounded cache isolates identity, language and changed content while unknown/binary/oversize sources stay plain', async () => {
  const engine = new CodeTokenizer(2, 10000);
  const request = { id: 1, identity: 's:a:v1:f:old', language: 'typescript', source: 'const value = 1;', lines: [1] };
  const first = await engine.highlight(request);
  const changed = await engine.highlight({ ...request, source: '/* unchanged key, new source */' });
  expect(changed.lines[0].tokens).not.toEqual(first.lines[0].tokens);
  for (let n = 0; n < 6; n++) await engine.highlight({ ...request, identity: `session-${n}:v${n}:new` });
  expect(engine.cacheEntries).toBe(2); expect(engine.cacheBytes).toBeLessThanOrEqual(10000);
  expect((await engine.highlight({ ...request, language: 'unknown' })).status).toBe(HighlightStatus.Unknown);
  expect((await engine.highlight({ ...request, source: 'abc\0def' })).status).toBe(HighlightStatus.Unavailable);
  expect((await engine.highlight({ ...request, source: '中'.repeat(Math.ceil(MAX_HIGHLIGHT_BYTES / 3) + 1) })).status).toBe(HighlightStatus.TooLarge);
});

test('a long patch requests only expanded lines from the complete parsed file', async () => {
  const source = Array.from({ length: 20000 }, (_, n) => `const variable${n} = ${n};`).join('\n');
  const result = await new CodeTokenizer().highlight({ id: 1, identity: 'large', path: 'large.ts', source, lines: Array.from({ length: 300 }, (_, n) => n + 15000) });
  expect(result.status).toBe(HighlightStatus.Ready);
  expect(result.lines).toHaveLength(300); expect(result.lines[0].number).toBe(15000); expect(result.lines[299].number).toBe(15299);
}, 15000);

test('shared semantic classes keep keywords, definitions, properties, strings and numeric literals distinct', async () => {
  const source = 'const config = { path: "hello", count: 42, ready: true };';
  const result = await new CodeTokenizer().highlight({ id: 1, identity: 'semantic-colors', path: 'config.ts', source, lines: [1] });
  const tagged = result.lines[0].tokens.map(token => [source.slice(token.from, token.to), token.className]);
  expect(tagged).toContainEqual(['const', 'tok-keyword']);
  expect(tagged).toContainEqual(['config', 'tok-name']);
  expect(tagged).toContainEqual(['path', 'tok-name']);
  expect(tagged).toContainEqual(['"hello"', 'tok-string']);
  expect(tagged).toContainEqual(['42', 'tok-constant']);
  expect(tagged).toContainEqual(['true', 'tok-constant']);
});
