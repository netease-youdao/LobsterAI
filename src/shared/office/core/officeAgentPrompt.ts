import type { OfficeEditorSpec } from './officeEditor';

const joinWithOr = (items: readonly string[]): string =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;

/**
 * The managed AGENTS.md section for the Office editors. Every format follows the same rules
 * (prefer the live editor, answer from the edit reply, no shell checks), so they are written once
 * and each editor adds one line with its tools; a section per format repeated them three times.
 */
export function buildOfficeAgentPrompt(editors: readonly OfficeEditorSpec[]): string {
  const guided = editors.flatMap(editor =>
    editor.agent.guidance ? [{ extension: editor.extension, guidance: editor.agent.guidance }] : []);
  if (guided.length === 0) return '';

  const extensions = joinWithOr(guided.map(({ extension }) => `\`${extension}\``));
  const editTools = joinWithOr(guided.map(({ guidance }) => `\`${guidance.editTool}\``));
  const replyShows = joinWithOr(guided.map(({ guidance }) => guidance.replyShows));
  const fileBasedFor = guided
    .flatMap(({ extension, guidance }) =>
      guidance.fileBasedFor ? [`\`${extension}\`: ${guidance.fileBasedFor}`] : [])
    .join('; ');

  return [
    '## Editing Existing Office Files',
    '',
    `- When the user wants to change an existing ${extensions} and that format's editor tools are available, use them instead of rewriting the file with scripts: edits appear live in LobsterAI's editor, keep the content you did not change, and can be undone.`,
    ...guided.map(({ extension, guidance }) =>
      `- \`${extension}\`: \`${guidance.readTool}\` / \`${guidance.editTool}\` (${guidance.keeps}).${guidance.scope ? ` ${guidance.scope}` : ''}`),
    `- Use file-based tools only for what the editor tools cannot do${fileBasedFor ? ` (${fileBasedFor})` : ''}, when the file is reported as read-only or an edit is refused, or to create a new file.`,
    `- After a successful ${editTools}, answer from its reply (the changed ${replyShows} as they now read, and the save status) and your earlier read, also when the user asks you to verify or check the change: the reply comes from the same open file a read would return, so another read verifies nothing and costs a full extra model request.`,
    '- The editor tools open the file and report whether it saved; do not check the file with shell commands before or after editing.',
  ].join('\n');
}
