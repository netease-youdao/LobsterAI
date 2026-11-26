export const RemoteTelemetryUiAction = { Open: 'open', Enable: 'enable', Disable: 'disable', RetryConnection: 'retry_connection',
  RetryTask: 'retry_task', Refresh: 'refresh', KeepAwake: 'keep_awake', Configure: 'configure' } as const;
export const RemoteTelemetryUiStage = { Open: 'open', Click: 'click', Result: 'result' } as const;
export const RemoteTelemetryUiSurface = { Popover: 'remote_popover', Devices: 'remote_devices', Settings: 'settings' } as const;
export interface RemoteTelemetryUiInput {
  expectedAccountEpoch: string;
  uiInteractionId: string;
  uiAction: typeof RemoteTelemetryUiAction[keyof typeof RemoteTelemetryUiAction];
  uiStage: typeof RemoteTelemetryUiStage[keyof typeof RemoteTelemetryUiStage];
  surface: typeof RemoteTelemetryUiSurface[keyof typeof RemoteTelemetryUiSurface];
  outcome?: 'committed' | 'failed';
}
export function validRemoteTelemetryUi(value: unknown): value is RemoteTelemetryUiInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RemoteTelemetryUiInput;
  return typeof v.expectedAccountEpoch === 'string' && v.expectedAccountEpoch.length <= 256
    && typeof v.uiInteractionId === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v.uiInteractionId)
    && (Object.values(RemoteTelemetryUiAction) as string[]).includes(v.uiAction)
    && (Object.values(RemoteTelemetryUiStage) as string[]).includes(v.uiStage)
    && (Object.values(RemoteTelemetryUiSurface) as string[]).includes(v.surface)
    && (v.outcome === undefined || v.outcome === 'committed' || v.outcome === 'failed');
}
