import type {
  NeteaseMailAction, NeteaseMailBodyFormat, NeteaseMailError, NeteaseMailFailure,
  NeteaseMailMessageMode, NeteaseMailOutcome, NeteaseMailTool, NeteaseMailView,
} from './constants';

export interface NeteaseMailAddress { email: string; name?: string }
export interface NeteaseMailAttachment { id?: string; name: string; size?: number; mimeType?: string }

/** Host presentation model. This is not a claim about the final provider wire schema. */
export interface NeteaseMailMessage {
  id?: string;
  from: NeteaseMailAddress[];
  to: NeteaseMailAddress[];
  cc: NeteaseMailAddress[];
  bcc: NeteaseMailAddress[];
  subject: string;
  body: string;
  format: NeteaseMailBodyFormat;
  attachments: NeteaseMailAttachment[];
  date?: string;
  unread?: boolean;
}

export type NeteaseMailPresentation =
  | {
    kind: typeof NeteaseMailView.Message;
    mode: NeteaseMailMessageMode;
    tool: NeteaseMailTool;
    message: NeteaseMailMessage;
    expiresAt?: number;
  }
  | { kind: typeof NeteaseMailView.List; messages: NeteaseMailMessage[]; hasMore: boolean; truncated?: boolean }
  | { kind: typeof NeteaseMailView.Notice; code: NeteaseMailError | NeteaseMailFailure };

export interface NeteaseMailAvailability {
  authorization: boolean;
  confirmation: boolean;
  account?: string;
  connected?: boolean;
  expiresAt?: number;
}

/** The adapter must resolve these identifiers against main-process-owned operations. */
export interface NeteaseMailConfirmationRequest {
  messageId: string;
  toolCallId: string;
  action: NeteaseMailAction;
}

export type NeteaseMailActionResult =
  | { success: true; outcome: NeteaseMailOutcome }
  | { success: false; code: NeteaseMailError | NeteaseMailFailure };

export interface NeteaseMailBridge {
  getAvailability(): Promise<NeteaseMailAvailability>;
  authorize(): Promise<NeteaseMailActionResult>;
  cancelAuthorization?(): Promise<NeteaseMailActionResult>;
  disconnect?(): Promise<NeteaseMailActionResult>;
  resolveConfirmation(request: NeteaseMailConfirmationRequest): Promise<NeteaseMailActionResult>;
}
