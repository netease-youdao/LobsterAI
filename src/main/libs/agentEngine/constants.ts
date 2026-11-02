export const AgentLifecyclePhase = {
  Start: 'start',
  End: 'end',
  Error: 'error',
  Fallback: 'fallback',
} as const;
export type AgentLifecyclePhase = typeof AgentLifecyclePhase[keyof typeof AgentLifecyclePhase];

export const AgentEventStream = {
  Assistant: 'assistant',
  /** A finished answer the same run continues past (zz-openclaw-plan-completion-check.patch). */
  Checkpoint: 'checkpoint',
  Lifecycle: 'lifecycle',
  /** Transport-drop retries of a model call (zzz-openclaw-stream-drop-reconnect.patch). */
  ModelRetry: 'model_retry',
  Tool: 'tool',
} as const;

export const ModelRetryPhase = {
  Retrying: 'retrying',
  Exhausted: 'exhausted',
} as const;
export type ModelRetryPhase = typeof ModelRetryPhase[keyof typeof ModelRetryPhase];

export const OpenClawChatState = {
  Delta: 'delta',
  Final: 'final',
  Aborted: 'aborted',
  Error: 'error',
} as const;
export type OpenClawChatState = typeof OpenClawChatState[keyof typeof OpenClawChatState];

export const OpenClawGatewayMethod = {
  ChatAbort: 'chat.abort',
  ChatSend: 'chat.send',
  SessionsSubscribe: 'sessions.subscribe',
  SessionsAbort: 'sessions.abort',
} as const;

export const OpenClawGatewayEvent = {
  Shutdown: 'shutdown',
  ChatSideResult: 'chat.side_result',
  SessionsChanged: 'sessions.changed',
  SubagentSettleFailed: 'lobsterai.subagent.settle_failed',
} as const;
