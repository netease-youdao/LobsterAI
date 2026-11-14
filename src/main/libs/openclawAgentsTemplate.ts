import crypto from 'crypto';

/**
 * Slims the parts of a workspace AGENTS.md that still read exactly as OpenClaw's
 * bundled template wrote them.
 *
 * The template is injected into every model request. Its group-chat etiquette
 * and tool notes are written at length, and its proactive sections tell the
 * model to invent recurring checks, which the managed heartbeat policy forbids
 * because every run costs the user money. A section is replaced only when its
 * text matches a template LobsterAI has shipped (ignoring blank lines and
 * per-line whitespace); a section the user or the agent has edited, added or
 * renamed never matches and is left byte for byte as it is.
 *
 * The Memory section is left alone on purpose: a shorter wording could not be
 * shown to keep the number of model requests of a "remember this" turn, and one
 * extra request costs more than the characters saved.
 */

const GROUP_CHATS_SECTION = [
  '## Group Chats',
  '',
  'You have access to your human\'s stuff. That doesn\'t mean you share it. In groups you are a participant, not their voice or their proxy.',
  '',
  '- **Respond when** directly mentioned or asked a question, when you can add genuine value, when something witty fits naturally, to correct important misinformation, or to summarize when asked.',
  '- **Stay silent when** it is casual banter between humans, someone already answered, or your reply would add nothing. Humans in group chats don\'t respond to every message; neither should you.',
  '- Send one thoughtful response rather than several fragments about the same message.',
  '- On platforms that support reactions (Discord, Slack), an emoji reaction can acknowledge a message without interrupting the flow. One reaction per message at most.',
].join('\n');

const PLATFORM_FORMATTING_LINE =
  '**Platform formatting:** on Discord and WhatsApp use bullet lists instead of markdown tables; on Discord wrap multiple links in `<>` to suppress embeds (`<https://example.com>`); on WhatsApp use **bold** or CAPS instead of headers.';

const TOOLS_SECTION_LEGACY = [
  '## Tools',
  '',
  'Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.',
  '',
  PLATFORM_FORMATTING_LINE,
].join('\n');

const TOOLS_SECTION = [
  '## Tools',
  '',
  'Skills define how tools work. This section is for details unique to your environment, such as camera names, SSH hosts, preferred TTS voices and device nicknames. Keeping them here lets shared skills update without losing your notes.',
  '',
  PLATFORM_FORMATTING_LINE,
].join('\n');

/** Marks a pristine section that is dropped instead of rewritten. */
const REMOVE_SECTION: null = null;

/**
 * SHA-256 of each template section LobsterAI has seeded into workspaces (text
 * normalized by `normalizeSectionText`), mapped to what replaces it. The
 * versions are the OpenClaw releases this app has pinned; add the new hashes
 * when a runtime upgrade changes `docs/reference/templates/AGENTS.md`.
 */
const PRISTINE_SECTION_REPLACEMENTS: ReadonlyMap<string, string | null> = new Map<string, string | null>([
  // ## Group Chats
  ['1096ef5a23ee55773bd8b8ae96052577fde11c2e9dd70379b516eabeba003dde', GROUP_CHATS_SECTION], // v2026.3.2 - v2026.4.14
  ['e107c66a9c06e5031ba2574ef72cc0949275250f107d0b199d82122ea33a74d4', GROUP_CHATS_SECTION], // v2026.6.1
  ['0c48324711949d484afa609190ecaa730ea9d6f2958c55836ff9a685a62e7593', GROUP_CHATS_SECTION], // v2026.8.1
  // ## Tools
  ['fa2ebfa3c41a8112766fca85ec817bf8fa5d393e8a43620553d7480b81a47d09', TOOLS_SECTION_LEGACY], // v2026.3.2 - v2026.6.1
  ['86d1105b00919218efe5d4ef446fb16471bbf99ca82d29ed74bb66e282281e4d', TOOLS_SECTION], // v2026.8.1
  // ## 💓 Heartbeats - Be Proactive!
  ['0db261523c833fc5fc8ce12e80b0286cb34178742ac626485a88183025a9c456', REMOVE_SECTION], // v2026.3.2 - v2026.4.8
  ['f910f808f36472907f93e7596de03602e44cdb180ef2b5c972eae1190a2f16d1', REMOVE_SECTION], // v2026.4.14 - v2026.6.1
  // ## Automations - Be Proactive
  ['931c008275900d5bc3f9d7b79a3c6de02a439acb225f69ab211ed2852a487519', REMOVE_SECTION], // v2026.8.1
  // ## Related: links into the OpenClaw docs site, which do not resolve in a workspace
  ['c87d4558d75e8ee9d7f330c11ddfa7031daf4b3ac25ffc7b54273e8b79b8262c', REMOVE_SECTION], // v2026.6.1
  ['865fc2ab614cef213001dfcd3be201a71bd8bd57eee1711f936f86827540cdc1', REMOVE_SECTION], // v2026.8.1
]);

const SECTION_HEADING_PREFIX = '## ';

const normalizeSectionText = (lines: readonly string[]): string =>
  lines
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');

export const hashAgentsTemplateSection = (lines: readonly string[]): string =>
  crypto.createHash('sha256').update(normalizeSectionText(lines)).digest('hex');

const countTrailingBlankLines = (lines: readonly string[]): number => {
  let count = 0;
  while (count < lines.length && lines[lines.length - 1 - count].trim() === '') {
    count += 1;
  }
  return count;
};

/**
 * Replace or remove the H2 sections that still match a shipped template.
 * Returns the input string itself when nothing matched, so an unchanged file is
 * never rewritten.
 */
export const slimPristineAgentsTemplateSections = (content: string): string => {
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  // Section 0 is whatever precedes the first H2 heading; it is never replaced.
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith(SECTION_HEADING_PREFIX)) {
      sections.push([line]);
    } else {
      sections[sections.length - 1].push(line);
    }
  }

  let changed = false;
  const nextLines: string[] = [...sections[0]];
  for (const section of sections.slice(1)) {
    const hash = hashAgentsTemplateSection(section);
    if (!PRISTINE_SECTION_REPLACEMENTS.has(hash)) {
      nextLines.push(...section);
      continue;
    }
    changed = true;
    const replacement = PRISTINE_SECTION_REPLACEMENTS.get(hash);
    if (replacement) {
      // Keep the blank lines that separated the section from the next one.
      nextLines.push(
        ...replacement.split('\n'),
        ...new Array<string>(countTrailingBlankLines(section)).fill(''),
      );
    }
  }

  return changed ? nextLines.join(lineEnding) : content;
};
