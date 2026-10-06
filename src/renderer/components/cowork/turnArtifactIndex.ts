import type { Artifact } from '../../types/artifact';
import { PREVIEWABLE_ARTIFACT_TYPES } from '../../types/artifact';
import { type ConversationTurn, getTurnMessageIds } from './messageDisplayUtils';

/** O(message references + artifacts + actual matches); retain input order, duplicates and object identity. */
export function indexTurnArtifacts<A extends Pick<Artifact, 'messageId' | 'type'>>(
  turns: readonly ConversationTurn[],
  artifacts: readonly A[],
): A[][] {
  const indicesByMessage = new Map<string, number[]>();
  const output = turns.map((turn, index) => {
    for (const messageId of getTurnMessageIds(turn)) {
      const indices = indicesByMessage.get(messageId);
      if (indices) indices.push(index);
      else indicesByMessage.set(messageId, [index]);
    }
    return [] as A[];
  });
  for (const artifact of artifacts) {
    if (!PREVIEWABLE_ARTIFACT_TYPES.has(artifact.type)) continue;
    for (const index of indicesByMessage.get(artifact.messageId) ?? [])
      output[index].push(artifact);
  }
  return output;
}
