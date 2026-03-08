import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const skillModule = require('../dist-electron/skillManager.js');
const testUtils = skillModule.__skillManagerTestUtils;

if (!testUtils) {
  throw new Error('__skillManagerTestUtils is not available');
}

const { parseFrontmatter, isTruthy, extractDescription } = testUtils;

// ==================== parseFrontmatter ====================

test('parseFrontmatter: simple key-value pairs', () => {
  const raw = '---\nname: demo\ndescription: A simple skill\nofficial: true\n---\n# Content here\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'demo');
  assert.equal(frontmatter.description, 'A simple skill');
  assert.equal(frontmatter.official, true); // YAML parses 'true' as boolean
  assert.equal(content.trim(), '# Content here');
});

test('parseFrontmatter: block scalar with pipe (|)', () => {
  const raw = '---\nname: demo\ndescription: |\n  A multi-line description.\n  Second line.\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'demo');
  assert.equal(frontmatter.description, 'A multi-line description.\nSecond line.\n');
  assert.equal(content.trim(), '# Content');
});

test('parseFrontmatter: folded scalar with greater-than (>)', () => {
  const raw = '---\nname: demo\ndescription: >\n  A folded\n  description.\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'demo');
  assert.equal(frontmatter.description, 'A folded description.\n');
});

test('parseFrontmatter: quoted strings', () => {
  const raw = '---\nname: "quoted name"\ndescription: \'single quoted\'\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'quoted name');
  assert.equal(frontmatter.description, 'single quoted');
});

test('parseFrontmatter: nested objects', () => {
  const raw = '---\nname: demo\nmetadata:\n  short-description: A short desc\n  version: 2\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'demo');
  assert.deepEqual(frontmatter.metadata, { 'short-description': 'A short desc', version: 2 });
});

test('parseFrontmatter: arrays', () => {
  const raw = '---\nname: demo\ntags:\n  - tool\n  - search\n  - web\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  assert.deepEqual(frontmatter.tags, ['tool', 'search', 'web']);
});

test('parseFrontmatter: boolean values as native YAML booleans', () => {
  const raw = '---\nname: demo\nofficial: true\nisOfficial: false\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  assert.equal(frontmatter.official, true);
  assert.equal(frontmatter.isOfficial, false);
});

test('parseFrontmatter: no frontmatter returns empty object and full content', () => {
  const raw = '# Just a heading\nSome content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.deepEqual(frontmatter, {});
  assert.equal(content, raw);
});

test('parseFrontmatter: empty frontmatter returns empty object', () => {
  const raw = '---\n\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.deepEqual(frontmatter, {});
  assert.equal(content.trim(), '# Content');
});

test('parseFrontmatter: BOM is stripped', () => {
  const raw = '\uFEFF---\nname: bom-test\n---\n# Content\n';
  const { frontmatter } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'bom-test');
});

test('parseFrontmatter: Windows line endings (CRLF)', () => {
  const raw = '---\r\nname: win\r\ndescription: windows\r\n---\r\n# Content\r\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'win');
  assert.equal(frontmatter.description, 'windows');
});

test('parseFrontmatter: invalid YAML returns empty frontmatter gracefully', () => {
  const raw = '---\n: invalid\n  bad:\n    - [\n---\n# Content\n';
  const { frontmatter, content } = parseFrontmatter(raw);
  assert.deepEqual(frontmatter, {});
  assert.ok(content.includes('# Content'));
});

// ==================== isTruthy ====================

test('isTruthy: native boolean true', () => {
  assert.equal(isTruthy(true), true);
});

test('isTruthy: native boolean false', () => {
  assert.equal(isTruthy(false), false);
});

test('isTruthy: string "true"', () => {
  assert.equal(isTruthy('true'), true);
  assert.equal(isTruthy('True'), true);
  assert.equal(isTruthy('TRUE'), true);
});

test('isTruthy: string "yes" and "1"', () => {
  assert.equal(isTruthy('yes'), true);
  assert.equal(isTruthy('1'), true);
});

test('isTruthy: string "false" and others', () => {
  assert.equal(isTruthy('false'), false);
  assert.equal(isTruthy('no'), false);
  assert.equal(isTruthy('0'), false);
  assert.equal(isTruthy('random'), false);
});

test('isTruthy: undefined and null', () => {
  assert.equal(isTruthy(undefined), false);
  assert.equal(isTruthy(null), false);
});

test('isTruthy: number and object', () => {
  assert.equal(isTruthy(1), false);
  assert.equal(isTruthy({}), false);
});

// ==================== extractDescription ====================

test('extractDescription: extracts first non-empty line', () => {
  assert.equal(extractDescription('\n\nFirst line\nSecond line\n'), 'First line');
});

test('extractDescription: strips markdown heading markers', () => {
  assert.equal(extractDescription('## Heading\nContent'), 'Heading');
  assert.equal(extractDescription('### Sub heading'), 'Sub heading');
});

test('extractDescription: returns empty string for empty content', () => {
  assert.equal(extractDescription(''), '');
  assert.equal(extractDescription('\n\n\n'), '');
});

// ==================== Integration: real-world SKILL.md patterns ====================

test('integration: typical official skill frontmatter', () => {
  const raw = [
    '---',
    'name: docx',
    'description: "Comprehensive document creation, editing, and analysis"',
    'license: Proprietary. LICENSE.txt has complete terms',
    'official: true',
    '---',
    '',
    '# DOCX creation, editing, and analysis',
    'Detailed instructions here.',
  ].join('\n');

  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'docx');
  assert.equal(frontmatter.description, 'Comprehensive document creation, editing, and analysis');
  assert.equal(frontmatter.license, 'Proprietary. LICENSE.txt has complete terms');
  assert.equal(isTruthy(frontmatter.official), true);
  assert.ok(content.includes('# DOCX creation'));
});

test('integration: skill with metadata nested object', () => {
  const raw = [
    '---',
    'name: create-plan',
    'description: Create a concise plan',
    'official: true',
    'metadata:',
    '  short-description: Create a plan',
    '---',
    '',
    '# Create Plan',
  ].join('\n');

  const { frontmatter } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'create-plan');
  assert.deepEqual(frontmatter.metadata, { 'short-description': 'Create a plan' });
});

test('integration: skill with block scalar description', () => {
  const raw = [
    '---',
    'name: demo',
    'description: |',
    '  A multi-line description.',
    '  Second line.',
    '---',
    '',
    '# Demo Skill',
  ].join('\n');

  const { frontmatter, content } = parseFrontmatter(raw);
  assert.equal(frontmatter.name, 'demo');
  assert.equal(String(frontmatter.description || '').trim(), 'A multi-line description.\nSecond line.');
  assert.ok(content.includes('# Demo Skill'));
});
