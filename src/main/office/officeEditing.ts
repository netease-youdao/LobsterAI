import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import type { OfficeEditorId, OfficeEditorSpec } from '../../shared/office/core/officeEditor';
import type { OfficeAgentToolResult, OfficePackageInfo, OfficePackageLimits } from '../../shared/office/core/officeFile';
import { OfficeAgentBridge } from './core/officeAgentBridge';
import { type OfficeCallerCheck, registerOfficeFileHandlers } from './core/officeFileHandlers';
import { OfficeFileStore } from './core/officeFileStore';
import { type OfficeMcpStdioLaunch, resolveOfficeMcpStdioLaunch } from './core/officeMcpServer';

/** One editor's main-process side. */
export interface MainOfficeFormat<TInfo extends OfficePackageInfo = OfficePackageInfo> {
  spec: OfficeEditorSpec;
  limits: OfficePackageLimits;
  /** Validate a package and classify it; throws OfficePackageException. */
  inspect: (bytes: Uint8Array) => TInfo;
  /** Log tags, e.g. `[SheetFiles]` and `[SheetAgent]`. */
  fileLogTag: string;
  agentLogTag: string;
  /** Registers the format's own channels next to the shared file channels. */
  registerExtraHandlers?: (context: { allowed: OfficeCallerCheck; userDataPath: string }) => void;
}

export interface OfficeMcpServerOptions {
  electronNodeRuntimePath: string;
  bridgeSecret: string;
  /** The loopback bridge URL of an editor's tool route, or null while the bridge is down. */
  callbackUrl: (id: OfficeEditorId) => string | null;
}

const failure = (text: string): OfficeAgentToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * The Office editors' main-process side: file channels, recovery drafts, exit protection, agent
 * tool calls and the MCP servers that expose those tools, set up from the format table.
 */
export class OfficeEditing {
  private readonly agents = new Map<OfficeEditorId, OfficeAgentBridge>();
  private readonly unsafeEdits: (() => boolean)[] = [];

  constructor(private readonly formats: readonly MainOfficeFormat[]) {}

  get editors(): OfficeEditorSpec[] {
    return this.formats.map(format => format.spec);
  }

  /** Registers every editor's IPC channels; call once when the app is ready. */
  register(getMainWindow: () => BrowserWindow | null): void {
    const userDataPath = app.getPath('userData');
    for (const format of this.formats) {
      const { spec } = format;
      const store = new OfficeFileStore({
        extension: spec.extension,
        maxFileBytes: format.limits.maxFileBytes,
        inspect: format.inspect,
        logTag: format.fileLogTag,
      }, path.join(userDataPath, `${spec.id}-drafts`));
      const agent = new OfficeAgentBridge({
        getWindow: getMainWindow,
        tools: spec.agent.tools.map(tool => tool.name),
        requestChannel: spec.channels.AgentRequest,
        timeoutMs: spec.agent.timeoutMs,
        editorName: spec.editorName,
        logTag: format.agentLogTag,
      });
      const handlers = registerOfficeFileHandlers({
        channels: spec.channels, store, agent, getMainWindow, editorName: spec.editorName, logTag: format.fileLogTag,
      });
      format.registerExtraHandlers?.({ allowed: handlers.allowed, userDataPath });
      this.agents.set(spec.id, agent);
      this.unsafeEdits.push(handlers.hasUnsafeEdits);
    }
  }

  /** Whether any editor holds edits that are not safely on disk yet. */
  hasUnsafeEdits(): boolean {
    return this.unsafeEdits.some(hasUnsafeEdits => hasUnsafeEdits());
  }

  /** Runs an agent tool against the document open in the editor. */
  callTool(id: OfficeEditorId, tool: string, args: Record<string, unknown>): Promise<OfficeAgentToolResult> {
    const agent = this.agents.get(id);
    if (agent) return agent.call(tool, args);
    const editorName = this.formats.find(format => format.spec.id === id)?.spec.editorName ?? 'Office';
    return Promise.resolve(failure(`The LobsterAI ${editorName} editor is not ready yet.`));
  }

  /** The MCP servers exposing the editors' tools, by server name; an editor without a bridge URL is left out. */
  mcpServers(baseDir: string, options: OfficeMcpServerOptions): Record<string, OfficeMcpStdioLaunch> {
    const servers: Record<string, OfficeMcpStdioLaunch> = {};
    for (const { spec, agentLogTag } of this.formats) {
      const bridgeUrl = options.callbackUrl(spec.id);
      if (!bridgeUrl) continue;
      try {
        servers[spec.agent.serverName] = resolveOfficeMcpStdioLaunch(baseDir, spec, {
          electronNodeRuntimePath: options.electronNodeRuntimePath,
          bridgeUrl,
          bridgeSecret: options.bridgeSecret,
        });
      } catch (error) {
        // The editor tools are optional; never let them break the rest of the config sync.
        console.warn(`${agentLogTag} Could not prepare the ${spec.editorName} MCP server:`, error);
      }
    }
    return servers;
  }
}
