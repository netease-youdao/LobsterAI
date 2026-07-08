export const AsrIpcChannel = {
  CreateRealtimeSession: 'asr:realtime:createSession',
} as const;

export type AsrIpcChannel = typeof AsrIpcChannel[keyof typeof AsrIpcChannel];

export const AsrLangType = {
  ZhChs: 'zh-CHS',
} as const;

export type AsrLangType = typeof AsrLangType[keyof typeof AsrLangType];

export const AsrApiCode = {
  Unauthorized: 401,
  AuthTokenInvalid: 40100,
  ConfigInvalid: 41400,
  AudioInvalid: 41401,
  AudioTooLarge: 41402,
  AudioTooLong: 41403,
  DailyLimitExceeded: 41404,
  UpstreamAuthFailed: 41405,
  UpstreamRateLimited: 41406,
  RecognitionFailed: 41407,
  UpstreamError: 50201,
  UpstreamBalanceInsufficient: 50203,
  UpstreamInvalidParams: 50204,
} as const;

export type AsrApiCode = typeof AsrApiCode[keyof typeof AsrApiCode];

export interface AsrRealtimeSessionRequest {
  langType?: AsrLangType;
}

export interface AsrRealtimeSessionData {
  requestId: string;
  wsUrl: string;
  expiresInSeconds: number;
  chunkIntervalMillis: number;
  maxSessionSeconds: number;
  maxConcurrentSessions: number;
  usedSecondsToday: number;
  remainingSecondsToday: number;
  limitSecondsToday: number;
}

export type AsrRealtimeSessionResult =
  | { success: true; data: AsrRealtimeSessionData }
  | { success: false; code?: number; error?: string; message?: string };

export const AsrRealtimeEventType = {
  Started: 'started',
  Recognition: 'recognition',
  Closed: 'closed',
  Error: 'error',
} as const;

export type AsrRealtimeEventType = typeof AsrRealtimeEventType[keyof typeof AsrRealtimeEventType];

export interface AsrRealtimeRecognitionRawItem {
  seg_id?: number;
  st?: {
    sentence?: string;
    partial?: boolean;
  };
}

export interface AsrRealtimeEvent {
  type?: AsrRealtimeEventType | string;
  code?: number;
  message?: string;
  requestId?: string;
  text?: string;
  raw?: {
    action?: string;
    errorCode?: string;
    result?: AsrRealtimeRecognitionRawItem[];
  };
}
