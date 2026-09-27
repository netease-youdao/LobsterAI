import type { WordAgentToolResult } from '../../shared/artifactPreview/wordAgent';

/**
 * Listens for agent Word tool calls from the main process. The editor engine is loaded only
 * when the first call arrives, so app startup does not pay for it.
 */
export function installWordAgentBridge(): () => void {
  const api = window.electron?.artifact?.word;
  if (!api?.onAgentRequest) return () => undefined;
  return api.onAgentRequest(request => {
    void import('./wordAgent')
      .then(({ handleWordAgentRequest }) => handleWordAgentRequest(request))
      .catch((error: unknown): WordAgentToolResult => {
        console.error('[WordAgent] Tool call failed:', error);
        return { content: [{ type: 'text', text: `The LobsterAI Word editor failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      })
      .then(result => api.respondAgent({ requestId: request.requestId, result }));
  });
}
