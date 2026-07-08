import { ipcMain } from 'electron';

import {
  AsrApiCode,
  AsrIpcChannel,
  type AsrRealtimeSessionData,
  type AsrRealtimeSessionRequest,
  type AsrRealtimeSessionResult,
} from '../../../shared/asr/constants';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

type AsrResponseBody = {
  code?: number;
  message?: string;
  data?: unknown;
};

const readAsrResponseBody = async (resp: Response): Promise<AsrResponseBody | null> => (
  await resp.json().catch((): null => null) as AsrResponseBody | null
);

const getAsrResponseMessage = (body: AsrResponseBody | null, resp: Response): string => (
  body?.message || resp.statusText || 'No response message'
);

const getSafeWebSocketEndpoint = (wsUrl: string): string => {
  try {
    const url = new URL(wsUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'unknown';
  }
};

export interface AsrHandlerDeps {
  getAuthTokens: () => AuthTokens | null;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  getServerApiBaseUrl: () => string;
}

export function registerAsrIpcHandlers({
  getAuthTokens,
  fetchWithAuth,
  getServerApiBaseUrl,
}: AsrHandlerDeps): void {
  ipcMain.handle(
    AsrIpcChannel.CreateRealtimeSession,
    async (_event, options?: AsrRealtimeSessionRequest): Promise<AsrRealtimeSessionResult> => {
      try {
        const tokens = getAuthTokens();
        if (!tokens) {
          console.warn('[ASR] realtime session request was rejected because no auth tokens are available');
          return { success: false, code: AsrApiCode.Unauthorized, error: 'Unauthorized' };
        }

        const params = new URLSearchParams();
        if (options?.langType) {
          params.set('langType', options.langType);
        }

        const serverBaseUrl = getServerApiBaseUrl();
        const requestUrl = `${serverBaseUrl}/api/asr/realtime/sessions`;
        console.log(`[ASR] realtime session request started for ${requestUrl} with langType=${options?.langType || 'default'}`);
        const resp = await fetchWithAuth(requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          },
          body: params.toString(),
        });
        const body = await readAsrResponseBody(resp);

        if (resp.ok && body?.code === 0 && body.data) {
          const data = body.data as AsrRealtimeSessionData;
          console.log(`[ASR] realtime session request succeeded; requestId=${data.requestId}, wsEndpoint=${getSafeWebSocketEndpoint(data.wsUrl)}, maxSessionSeconds=${data.maxSessionSeconds}, remainingSecondsToday=${data.remainingSecondsToday}`);
          return { success: true, data };
        }

        console.warn(`[ASR] realtime session request to ${requestUrl} was rejected with code ${body?.code ?? resp.status}, HTTP status ${resp.status}, and message: ${getAsrResponseMessage(body, resp)}`);

        return {
          success: false,
          code: body?.code ?? resp.status,
          error: body?.message || resp.statusText || 'ASR realtime session request failed',
          message: body?.message,
        };
      } catch (error) {
        console.warn('[ASR] realtime session request failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'ASR realtime session request failed',
        };
      }
    },
  );
}
