export const ManualCredentialCaptureChannel = {
  Event: 'lobster:browser-credential:capture-event',
} as const;

export const ManualCredentialCaptureEventType = {
  Submitted: 'submitted',
  PageState: 'page-state',
} as const;

export type ManualCredentialCaptureEventType =
  typeof ManualCredentialCaptureEventType[keyof typeof ManualCredentialCaptureEventType];

export const ManualCredentialFormKind = {
  Login: 'login',
  Registration: 'registration',
} as const;

export type ManualCredentialFormKind =
  typeof ManualCredentialFormKind[keyof typeof ManualCredentialFormKind];

export interface ManualCredentialSubmittedEvent {
  type: typeof ManualCredentialCaptureEventType.Submitted;
  username: string;
  password: string;
  formKind: ManualCredentialFormKind;
}

export interface ManualCredentialPageStateEvent {
  type: typeof ManualCredentialCaptureEventType.PageState;
  hasPasswordField: boolean;
}

export type ManualCredentialCaptureEvent =
  | ManualCredentialSubmittedEvent
  | ManualCredentialPageStateEvent;

export const parseManualCredentialCaptureEvent = (
  value: unknown,
): ManualCredentialCaptureEvent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.type === ManualCredentialCaptureEventType.PageState) {
    return typeof event.hasPasswordField === 'boolean'
      ? { type: ManualCredentialCaptureEventType.PageState, hasPasswordField: event.hasPasswordField }
      : null;
  }
  if (event.type !== ManualCredentialCaptureEventType.Submitted) return null;
  if (typeof event.username !== 'string' || typeof event.password !== 'string') return null;
  if (!Object.values(ManualCredentialFormKind).includes(event.formKind as ManualCredentialFormKind)) {
    return null;
  }
  return {
    type: ManualCredentialCaptureEventType.Submitted,
    username: event.username,
    password: event.password,
    formKind: event.formKind as ManualCredentialFormKind,
  };
};
