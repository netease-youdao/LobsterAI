import type { OfficeFileChannels } from './officeFile';

/**
 * The in-place Office editors. An id also names the editor's IPC channels (`artifact:<id>:*`),
 * its agent tool route and its recovery draft directory, so it never changes once shipped.
 */
export const OfficeEditorId = {
  Word: 'word',
  Sheet: 'sheet',
  Slides: 'slides',
} as const;
export type OfficeEditorId = typeof OfficeEditorId[keyof typeof OfficeEditorId];

/** An agent tool as the MCP server lists it. */
export interface OfficeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

/** What every process knows about one editor; each layer adds its own parts in its format table. */
export interface OfficeEditorSpec {
  readonly id: OfficeEditorId;
  /** Product name used in messages the agent reads, e.g. `Excel`. */
  readonly editorName: string;
  /** Lower-case extension of the files the editor opens, including the dot. */
  readonly extension: string;
  readonly channels: OfficeFileChannels;
  readonly agent: {
    /** The LobsterAI-managed MCP server that exposes the tools to OpenClaw. */
    readonly serverName: string;
    readonly tools: readonly OfficeToolDefinition[];
    readonly timeoutMs: number;
    /** Guidance for the managed AGENTS.md section, when the tool descriptions are not enough. */
    readonly prompt?: string;
  };
}
