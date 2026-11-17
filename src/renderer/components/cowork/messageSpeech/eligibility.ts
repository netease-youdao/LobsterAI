import { CoworkTurnOutcome, getCoworkTurnOutcome } from '../../../../shared/cowork/turnOutcome';
import { type CoworkSessionStatus, CoworkSessionStatusValue } from '../../../types/cowork';
import { type ConversationTurn, isModelChangeMessage } from '../messageDisplayUtils';

interface TurnSpeechContext {
  isLastTurn: boolean;
  sessionStatus: CoworkSessionStatus;
  isStreaming: boolean;
  hasRunningSubagents: boolean;
}

export function getLastMessageSpeechTurnIndex(turns: ConversationTurn[]): number {
  // Switching models adds standalone notices, not another execution. The last
  // legacy reply still belongs to the session's terminal completed run.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.userMessage || turn.assistantItems.length === 0
      || !turn.assistantItems.every(item => item.type === 'system' && isModelChangeMessage(item.message))) return index;
  }
  return -1;
}

export function isMessageSpeechTurnCompleted(turn: ConversationTurn, context: TurnSpeechContext): boolean {
  if ((context.isLastTurn && context.isStreaming) || context.hasRunningSubagents) return false;
  const messages = turn.assistantItems.flatMap(item => item.type === 'assistant' || item.type === 'system' ? [item.message] : []);
  if (messages.some(message => {
    const metadata = message.metadata;
    return metadata?.isError || metadata?.error || metadata?.isTimeout || metadata?.isIncomplete || metadata?.isTruncated;
  })) return false;
  const answer = [...messages].reverse().find(message => message.type === 'assistant' && !message.metadata?.isThinking);
  if (!answer || answer.metadata?.isStreaming) return false;
  const outcome = getCoworkTurnOutcome(turn.userMessage?.metadata) ?? getCoworkTurnOutcome(answer.metadata);
  if (outcome) return outcome === CoworkTurnOutcome.Completed;
  // Legacy history has no per-turn outcome. Only its terminal completed session is authoritative;
  // a stopped earlier turn can also carry isFinal, so never infer success from that flag alone.
  return context.isLastTurn && context.sessionStatus === CoworkSessionStatusValue.Completed;
}
