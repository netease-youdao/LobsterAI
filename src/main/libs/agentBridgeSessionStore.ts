export type AgentBridgeSessionMode = 'agent' | 'text-fast';
const TEXT_FAST_TRANSCRIPT_LIMIT = 40;

export interface AgentBridgeTextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentBridgeBinding {
  airiSessionId: string;
  lobsterSessionId: string;
  sessionMode?: AgentBridgeSessionMode;
  createdAt: number;
  updatedAt: number;
  seq: number;
  textTranscript: AgentBridgeTextMessage[];
}

export interface AgentBridgeFileBinding {
  id: string;
  airiSessionId: string;
  lobsterSessionId: string;
  clientTurnId?: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  mimeType: string;
  path: string;
  size: number;
}

export interface AgentBridgePermissionBinding {
  requestId: string;
  capabilityToken: string;
  airiSessionId: string;
  lobsterSessionId: string;
  turnId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export class AgentBridgeSessionStore {
  private bindings = new Map<string, AgentBridgeBinding>();
  private files = new Map<string, AgentBridgeFileBinding>();
  private permissions = new Map<string, AgentBridgePermissionBinding>();

  get(airiSessionId: string): AgentBridgeBinding | null {
    return this.bindings.get(airiSessionId) ?? null;
  }

  bind(
    airiSessionId: string,
    lobsterSessionId: string,
    sessionMode?: AgentBridgeSessionMode,
    options: { replaceSessionMode?: boolean } = {},
  ): AgentBridgeBinding {
    const now = Date.now();
    const existing = this.bindings.get(airiSessionId);
    const next: AgentBridgeBinding = existing
      ? {
          ...existing,
          lobsterSessionId,
          sessionMode: options.replaceSessionMode ? sessionMode : (existing.sessionMode ?? sessionMode),
          updatedAt: now,
        }
      : {
          airiSessionId,
          lobsterSessionId,
          sessionMode,
          createdAt: now,
          updatedAt: now,
          seq: 0,
          textTranscript: [],
        };
    this.bindings.set(airiSessionId, next);
    return next;
  }

  touch(airiSessionId: string): AgentBridgeBinding | null {
    const existing = this.bindings.get(airiSessionId);
    if (!existing) return null;
    const next = {
      ...existing,
      updatedAt: Date.now(),
    };
    this.bindings.set(airiSessionId, next);
    return next;
  }

  nextSeq(airiSessionId: string): number {
    const existing = this.bindings.get(airiSessionId);
    if (!existing) {
      return 1;
    }
    const next = {
      ...existing,
      seq: existing.seq + 1,
      updatedAt: Date.now(),
    };
    this.bindings.set(airiSessionId, next);
    return next.seq;
  }

  appendTextMessage(airiSessionId: string, message: AgentBridgeTextMessage): AgentBridgeBinding | null {
    const existing = this.bindings.get(airiSessionId);
    if (!existing)
      return null;
    const next = {
      ...existing,
      updatedAt: Date.now(),
      textTranscript: [...existing.textTranscript, message].slice(-TEXT_FAST_TRANSCRIPT_LIMIT),
    };
    this.bindings.set(airiSessionId, next);
    return next;
  }

  listTextMessages(airiSessionId: string): AgentBridgeTextMessage[] {
    return this.bindings.get(airiSessionId)?.textTranscript ?? [];
  }

  delete(airiSessionId: string): void {
    this.bindings.delete(airiSessionId);
    for (const [fileId, file] of this.files.entries()) {
      if (file.airiSessionId === airiSessionId) {
        this.files.delete(fileId);
      }
    }
    for (const [requestId, permission] of this.permissions.entries()) {
      if (permission.airiSessionId === airiSessionId) {
        this.permissions.delete(requestId);
      }
    }
  }

  bindFile(file: AgentBridgeFileBinding): AgentBridgeFileBinding {
    this.files.set(file.id, file);
    return file;
  }

  getFile(fileId: string): AgentBridgeFileBinding | null {
    return this.files.get(fileId) ?? null;
  }

  bindPermission(permission: AgentBridgePermissionBinding): AgentBridgePermissionBinding {
    this.permissions.set(permission.requestId, permission);
    return permission;
  }

  getPermission(requestId: string): AgentBridgePermissionBinding | null {
    return this.permissions.get(requestId) ?? null;
  }

  listPermissions(airiSessionId: string): AgentBridgePermissionBinding[] {
    return Array.from(this.permissions.values()).filter(permission => permission.airiSessionId === airiSessionId);
  }

  consumePermission(requestId: string, airiSessionId: string, capabilityToken: string): AgentBridgePermissionBinding | null {
    const permission = this.permissions.get(requestId) ?? null;
    if (!permission)
      return null;
    if (permission.airiSessionId !== airiSessionId)
      return null;
    if (permission.capabilityToken !== capabilityToken)
      return null;
    this.permissions.delete(requestId);
    return permission;
  }

  deletePermission(requestId: string): void {
    this.permissions.delete(requestId);
  }
}
