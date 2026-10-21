import yaml from 'js-yaml';
import { describe, expect, test } from 'vitest';

import { loadSkillFrontmatterYaml } from './skillFrontmatter';

const yamlErrorMessage = (block: string): string => {
  try {
    yaml.load(block);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the block to be invalid YAML');
};

describe('loadSkillFrontmatterYaml', () => {
  test('parses valid YAML unchanged', () => {
    expect(loadSkillFrontmatterYaml('name: demo\ndescription: "Use when: asked"\nversion: 1.0.0')).toEqual({
      name: 'demo',
      description: 'Use when: asked',
      version: '1.0.0',
    });
  });

  // The free-form descriptions OpenClaw recovers in its own frontmatter tests.
  test.each([
    'Use when: the user asks for a summary',
    'Use anime style IMPORTANT: Must be kawaii',
    '[Beta] Builds prereleases',
    '@scope/package helper',
    '*Experimental',
  ])('recovers the free-form description %j with the other fields', (description) => {
    const block = `name: demo\ndescription: ${description}\nversion: "1.2.3"`;
    expect(loadSkillFrontmatterYaml(block)).toEqual({ name: 'demo', description, version: '1.2.3' });
  });

  test('recovers a nested metadata.version next to a free-form description', () => {
    const block = 'name: demo\ndescription: Use when: asked\nmetadata:\n  author: me\n  version: "2.0"';
    expect(loadSkillFrontmatterYaml(block)).toEqual({
      name: 'demo',
      description: 'Use when: asked',
      metadata: { author: 'me', version: '2.0' },
    });
  });

  test('recovers CRLF line endings', () => {
    expect(loadSkillFrontmatterYaml('name: demo\r\ndescription: Use when: asked\r\nversion: 1.0.0')).toEqual({
      name: 'demo',
      description: 'Use when: asked',
      version: '1.0.0',
    });
  });

  test('keeps a partly quoted description as literal text', () => {
    expect(loadSkillFrontmatterYaml('description: "Use" when: needed')).toEqual({
      description: '"Use" when: needed',
    });
  });

  test('keeps replacement patterns in the description literal', () => {
    const description = "Costs $& or $' more: really";
    expect(loadSkillFrontmatterYaml(`description: ${description}`)).toEqual({ description });
  });

  test.each([
    ['a tab-indented key', 'name: demo\ndescription: ok\nmetadata:\n\tauthor: me'],
    ['a duplicated key', 'name: a\nname: b\ndescription: ok'],
    ['an unquoted colon outside the description', 'name: demo\ndescription: ok\nwhen_to_use: Use when: asked'],
    ['a block scalar description', 'description: >\n  Folded text\nwhen_to_use: Use when: asked'],
  ])('rethrows the original error for %s', (_name, block) => {
    expect(() => loadSkillFrontmatterYaml(block)).toThrow(yamlErrorMessage(block));
  });
});
