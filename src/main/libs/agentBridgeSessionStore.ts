export interface AgentBridgeBinding {
  airiSessionId: string;
  lobsterSessionId: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface AgentBridgeFileBinding {
  id: string;
  airiSessionId: string;
  lobsterSessionId: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  mimeType: string;
  path: string;
  size: number;
}

export interface AgentBridgePermissionBinding {
  requestId: string;
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

  bind(airiSessionId: string, lobsterSessionId: string): AgentBridgeBinding {
    const now = Date.now();
    const existing = this.bindings.get(airiSessionId);
    const next: AgentBridgeBinding = existing
      ? {
          ...existing,
          lobsterSessionId,
          updatedAt: now,
        }
      : {
          airiSessionId,
          lobsterSessionId,
          createdAt: now,
          updatedAt: now,
          seq: 0,
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

  consumePermission(requestId: string): AgentBridgePermissionBinding | null {
    const permission = this.permissions.get(requestId) ?? null;
    if (permission) {
      this.permissions.delete(requestId);
    }
    return permission;
  }

  deletePermission(requestId: string): void {
    this.permissions.delete(requestId);
  }
}
