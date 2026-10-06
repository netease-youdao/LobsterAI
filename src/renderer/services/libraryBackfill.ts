import {
  isLibraryArtifactType,
  LIBRARY_INDEX_POLICY_VERSION,
  LibraryOrigin,
  LibraryRelationKind,
} from '../../shared/library/constants';
import type { LibraryArtifactCandidate } from '../../shared/library/types';
import type { CoworkMessage } from '../types/cowork';
import { collectSessionArtifacts } from './artifactDetection';

const SESSION_BATCH_SIZE = 8;
const MESSAGE_PAGE_SIZE = 200;

interface BackfillCursor {
  offset: number;
}

let backfillPromise: Promise<void> | null = null;

const readCursor = (value?: string): BackfillCursor => {
  if (!value) return { offset: 0 };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { offset: 0 };
    const offset = (parsed as Record<string, unknown>).offset;
    return Number.isSafeInteger(offset) && (offset as number) >= 0
      ? { offset: offset as number }
      : { offset: 0 };
  } catch {
    return { offset: 0 };
  }
};

const waitForIdle = (): Promise<void> => new Promise(resolve => {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => resolve(), { timeout: 1_000 });
  } else {
    setTimeout(resolve, 50);
  }
});

const loadAllMessages = async (sessionId: string): Promise<CoworkMessage[]> => {
  const messages: CoworkMessage[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const result = await window.electron.cowork.getSessionMessages({
      sessionId,
      limit: MESSAGE_PAGE_SIZE,
      offset,
    });
    if (!result.success || !result.messages?.length) break;
    messages.push(...result.messages as CoworkMessage[]);
    offset += result.messages.length;
    total = result.total ?? offset;
    if (result.messages.length < MESSAGE_PAGE_SIZE) break;
    await waitForIdle();
  }
  return messages;
};

const runLibraryBackfill = async (): Promise<void> => {
  const library = window.electron?.library;
  if (!library) return;
  const stateResult = await library.getBackfillState();
  if (!stateResult.success) return;
  if (
    stateResult.data.policyVersion === LIBRARY_INDEX_POLICY_VERSION
    && stateResult.data.completedAt
  ) {
    return;
  }
  let cursor = stateResult.data.policyVersion === LIBRARY_INDEX_POLICY_VERSION
    ? readCursor(stateResult.data.cursor)
    : { offset: 0 };

  while (true) {
    await waitForIdle();
    const sessionsResult = await window.electron.cowork.listSessions({
      limit: SESSION_BATCH_SIZE,
      offset: cursor.offset,
    });
    if (!sessionsResult.success || !sessionsResult.sessions) return;

    for (const summary of sessionsResult.sessions) {
      await waitForIdle();
      const sessionResult = await window.electron.cowork.getSession(summary.id);
      if (!sessionResult.success || !sessionResult.session) continue;
      const messages = await loadAllMessages(summary.id);
      const candidates = collectSessionArtifacts(
        messages,
        summary.id,
        sessionResult.session.cwd,
      ).map((artifact): LibraryArtifactCandidate | null => {
        if (!artifact.filePath || !isLibraryArtifactType(artifact.type)) return null;
        return {
          sessionId: summary.id,
          messageId: artifact.messageId,
          sessionArtifactId: artifact.id,
          filePath: artifact.filePath,
          detectedType: artifact.type,
          relationKind: LibraryRelationKind.Referenced,
          relatedAt: artifact.createdAt > 0 ? artifact.createdAt : summary.updatedAt,
          origin: LibraryOrigin.Backfill,
        };
      }).filter((candidate): candidate is LibraryArtifactCandidate => candidate !== null);
      for (let index = 0; index < candidates.length; index += 100) {
        await library.recordCandidates(candidates.slice(index, index + 100));
      }
    }

    cursor = { offset: cursor.offset + sessionsResult.sessions.length };
    const completed = sessionsResult.sessions.length < SESSION_BATCH_SIZE
      || !sessionsResult.hasMore;
    await library.setBackfillState({
      policyVersion: LIBRARY_INDEX_POLICY_VERSION,
      cursor: JSON.stringify(cursor),
      ...(completed ? { completedAt: Date.now() } : {}),
    });
    if (completed) return;
  }
};

export const startLibraryBackfill = (): Promise<void> => {
  if (!backfillPromise) {
    backfillPromise = runLibraryBackfill().catch(error => {
      console.debug('[Library] Historical artifact backfill paused.', error);
      backfillPromise = null;
    });
  }
  return backfillPromise;
};
