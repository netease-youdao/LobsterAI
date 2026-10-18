import { useEffect, useMemo, useRef, useState } from 'react';

import { requestFollowUpSuggestion } from '../../services/followUpSuggestion';
import type { CoworkSession } from '../../types/cowork';
import { getFollowUpContext } from './followUpSuggestion';

interface RequestOwner { mounted: boolean; accountScope: string }
interface CachedSuggestion {
  request: Promise<string | null>;
  owners: Set<RequestOwner>;
  dismissed: boolean;
}
// Survives detail-page remounts; bounded and isolated by login generation and exact turn.
const suggestions = new Map<string, CachedSuggestion>();

export function useFollowUpSuggestion({ session, enabled, accountScope, language }: {
  session: CoworkSession | null | undefined; enabled: boolean; accountScope: string; language: string;
}) {
  const context = useMemo(() => getFollowUpContext(session), [session]);
  const key = context ? JSON.stringify([accountScope, language, context.key]) : '';
  const [result, setResult] = useState<{ key: string; text: string | null } | null>(null);
  const [revision, refresh] = useState(0);
  const owner = useRef<RequestOwner>({ mounted: true, accountScope });
  owner.current.accountScope = accountScope;
  useEffect(() => {
    const current = owner.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      for (const entry of suggestions.values()) entry.owners.delete(current);
    };
  }, []);
  useEffect(() => {
    if (!enabled || !context || !key || suggestions.get(key)?.dismissed) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      let entry = suggestions.get(key);
      if (!entry) {
        const owners = new Set([owner.current]);
        const request = requestFollowUpSuggestion(context, language, () => [...owners].some(item => item.mounted && item.accountScope === accountScope));
        entry = { request, owners, dismissed: false };
        if (suggestions.size >= 32) suggestions.delete(suggestions.keys().next().value!);
        suggestions.set(key, entry);
      }
      entry.owners.add(owner.current);
      void entry.request.then(text => { if (!cancelled) setResult({ key, text }); });
    }, 650);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [enabled, context, key, language, revision, accountScope]);
  return {
    suggestion: enabled && key && !suggestions.get(key)?.dismissed && result?.key === key ? result.text : null,
    dismiss: () => {
      const entry = suggestions.get(key);
      if (entry) entry.dismissed = true;
      refresh(value => value + 1);
    },
  };
}
