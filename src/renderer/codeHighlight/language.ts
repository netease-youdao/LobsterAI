import { LanguageDescription, type LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

const aliases: Record<string, string> = {
  js: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', md: 'markdown', objc: 'objective-c', cs: 'c#', kt: 'kotlin', tf: 'hcl', proto: 'protobuf', gql: 'graphql',
  react: 'jsx', svg: 'xml', mermaid: 'markdown',
};

/** Exact aliases and file extensions; never guess a grammar from a substring. */
export function resolveCodeLanguage(name?: string | null, path?: string): LanguageDescription | null {
  const lower = name?.trim().toLowerCase();
  if (lower && !['text', 'plaintext', 'plain'].includes(lower)) {
    const found = LanguageDescription.matchLanguageName(languages, aliases[lower] ?? lower, false);
    if (found) return found;
  }
  return path ? LanguageDescription.matchFilename(languages, path) : null;
}

export function codeFenceLanguage(className: string): string | null {
  return /(?:^|\s)language-([^\s]+)/.exec(className)?.[1]?.toLowerCase() ?? null;
}

export const codeLanguageForFence = (info: string): LanguageDescription | null => resolveCodeLanguage(info.trim().split(/\s+/)[0]);
let markdownSupport: Promise<LanguageSupport> | undefined;
export function loadCodeLanguage(description: LanguageDescription): Promise<LanguageSupport> {
  if (description.name !== 'Markdown') return description.load();
  return markdownSupport ??= import('@codemirror/lang-markdown').then(({ markdown, markdownLanguage }) =>
    markdown({ base: markdownLanguage, codeLanguages: codeLanguageForFence }));
}

/** Standalone worker parses have no EditorView to resume an asynchronously skipped fenced grammar. */
export async function prepareFencedLanguages(source: string): Promise<void> {
  const { markdownLanguage } = await import('@codemirror/lang-markdown');
  const descriptions = new Set<LanguageDescription>();
  markdownLanguage.parser.parse(source).iterate({ enter(node) {
    if (node.name !== 'FencedCode') return;
    const info = node.node.getChild('CodeInfo');
    const language = info ? codeLanguageForFence(source.slice(info.from, info.to)) : null;
    if (language) descriptions.add(language);
  } });
  await Promise.all([...descriptions].map(description => description.load()));
}
