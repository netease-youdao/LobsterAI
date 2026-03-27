import type { MentionItem } from './types';
import { extractMentionTokens } from './mentionTokenUtils';

interface ResolveMentionEntriesParams<TItem extends MentionItem> {
  value: string;
  items: TItem[];
  describeItem: (item: TItem) => string;
}

interface ResolveMentionEntriesResult {
  resolvedMentionLines: string[];
  unresolvedMentionTokens: string[];
}

export const resolveMentionEntries = <TItem extends MentionItem>({
  value,
  items,
  describeItem,
}: ResolveMentionEntriesParams<TItem>): ResolveMentionEntriesResult => {
  const mentionedTokens = extractMentionTokens(value.trim());
  const itemByMentionToken = new Map(items.map((item) => [item.mentionToken, item] as const));
  const resolvedMentionLines: string[] = [];
  const unresolvedMentionTokens: string[] = [];

  for (const token of mentionedTokens) {
    const item = itemByMentionToken.get(token);
    if (!item) {
      unresolvedMentionTokens.push(token);
      continue;
    }

    resolvedMentionLines.push(`@${token} => ${describeItem(item)}`);
  }

  return {
    resolvedMentionLines,
    unresolvedMentionTokens,
  };
};
