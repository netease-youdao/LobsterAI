import type { OfficeAgentToolResult } from '../../shared/artifactPreview/officeEditing';

/**
 * Listens for agent Excel tool calls from the main process. The spreadsheet engine is loaded
 * only when the first call arrives, so app startup does not pay for it.
 */
export function installSheetAgentBridge(): () => void {
  const api = window.electron?.artifact?.sheet;
  if (!api?.onAgentRequest) return () => undefined;
  return api.onAgentRequest(request => {
    void import('./sheet/sheetAgent')
      .then(({ handleSheetAgentRequest }) => handleSheetAgentRequest(request))
      .catch((error: unknown): OfficeAgentToolResult => {
        console.error('[SheetAgent] Tool call failed:', error);
        return { content: [{ type: 'text', text: `The LobsterAI Excel editor failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      })
      .then(result => api.respondAgent({ requestId: request.requestId, result }));
  });
}
