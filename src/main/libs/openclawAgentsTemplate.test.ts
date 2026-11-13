import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { slimPristineAgentsTemplateSections } from './openclawAgentsTemplate';

// Verbatim sections of OpenClaw's bundled AGENTS.md template (v2026.6.1), as
// LobsterAI seeded them into workspaces.
const PRISTINE_TOOLS_SECTION = [
  '## Tools',
  '',
  'Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.',
  '',
  '**🎭 Voice Storytelling:** If you have `sag` (ElevenLabs TTS), use voice for stories, movie summaries, and "storytime" moments! Way more engaging than walls of text. Surprise people with funny voices.',
  '',
  '**📝 Platform Formatting:**',
  '',
  '- **Discord/WhatsApp:** No markdown tables! Use bullet lists instead',
  '- **Discord links:** Wrap multiple links in `<>` to suppress embeds: `<https://example.com>`',
  '- **WhatsApp:** No headers — use **bold** or CAPS for emphasis',
].join('\n');

const PRISTINE_RELATED_SECTION = [
  '## Related',
  '',
  '- [Default AGENTS.md](/reference/AGENTS.default)',
].join('\n');

const USER_SECTION = [
  '## My Rules',
  '',
  '- Always answer in Chinese.',
  '',
  '',
  '- Keep   this spacing as it is.',
].join('\n');

const buildContent = (...sections: string[]): string =>
  ['# AGENTS.md - Your Workspace', '', 'This folder is home. Treat it that way.', '', sections.join('\n\n')].join('\n');

describe('slimPristineAgentsTemplateSections', () => {
  test('rewrites a pristine template section and keeps its rules', () => {
    const result = slimPristineAgentsTemplateSections(buildContent(PRISTINE_TOOLS_SECTION, USER_SECTION));

    expect(result).not.toContain('Voice Storytelling');
    expect(result).toContain('## Tools');
    expect(result).toContain('Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.');
    expect(result).toContain('on Discord and WhatsApp use bullet lists instead of markdown tables');
    expect(result.length).toBeLessThan(buildContent(PRISTINE_TOOLS_SECTION, USER_SECTION).length);
  });

  test('leaves user-written sections byte for byte as they are', () => {
    const result = slimPristineAgentsTemplateSections(buildContent(PRISTINE_TOOLS_SECTION, USER_SECTION));

    expect(result.endsWith(USER_SECTION)).toBe(true);
    // One blank line still separates the rewritten section from the next one.
    expect(result).toContain('instead of headers.\n\n## My Rules');
  });

  test('removes template sections that have no use in a LobsterAI workspace', () => {
    const result = slimPristineAgentsTemplateSections(buildContent(USER_SECTION, PRISTINE_RELATED_SECTION));

    expect(result).not.toContain('## Related');
    expect(result).not.toContain('/reference/AGENTS.default');
    expect(result.trimEnd().endsWith(USER_SECTION)).toBe(true);
  });

  test('does not touch a template section the user or the agent has edited', () => {
    const edited = `${PRISTINE_TOOLS_SECTION}\n- **Slack:** keep replies in threads`;
    const content = buildContent(edited, PRISTINE_RELATED_SECTION.replace('Default AGENTS.md', 'My notes'));

    expect(slimPristineAgentsTemplateSections(content)).toBe(content);
  });

  test('returns the same string when nothing matches', () => {
    const content = buildContent(USER_SECTION);

    expect(slimPristineAgentsTemplateSections(content)).toBe(content);
    expect(slimPristineAgentsTemplateSections('')).toBe('');
  });

  test('is idempotent', () => {
    const once = slimPristineAgentsTemplateSections(buildContent(PRISTINE_TOOLS_SECTION, PRISTINE_RELATED_SECTION));

    expect(slimPristineAgentsTemplateSections(once)).toBe(once);
  });

  test('matches a template saved with CRLF line endings and trailing whitespace, and keeps CRLF', () => {
    const crlf = buildContent(PRISTINE_TOOLS_SECTION, USER_SECTION)
      .split('\n')
      .map(line => (line.startsWith('Skills provide') ? `${line}  ` : line))
      .join('\r\n');

    const result = slimPristineAgentsTemplateSections(crlf);

    expect(result).not.toContain('Voice Storytelling');
    expect(result).toContain('\r\n');
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('slims the bundled runtime template, so a new workspace is not seeded with proactive checks', () => {
    const templatePath = path.join(
      process.cwd(),
      'vendor',
      'openclaw-runtime',
      'current',
      'docs',
      'reference',
      'templates',
      'AGENTS.md',
    );
    let bundled: string;
    try {
      bundled = fs.readFileSync(templatePath, 'utf8');
    } catch {
      return; // runtime not built in this checkout — covered by the fixture tests above
    }

    const result = slimPristineAgentsTemplateSections(bundled);

    // A runtime upgrade that rewords one of these sections fails here: add its
    // hash to PRISTINE_SECTION_REPLACEMENTS.
    expect(result).not.toContain('Be Proactive');
    expect(result).not.toContain('## Related');
    expect(result).not.toContain('storytelling');
    expect(result).not.toContain('### React Like a Human');
    // The Memory section is not rewritten.
    expect(result).toContain('### Write It Down');
    expect(bundled.length - result.length).toBeGreaterThan(2500);
  });
});
