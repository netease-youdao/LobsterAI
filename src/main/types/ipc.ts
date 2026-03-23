/**
 * Common Types for IPC Communication
 * 
 * This module provides type definitions to replace `any` types
 * in IPC handlers and event callbacks.
 */

import type { IpcMainInvokeEvent } from 'electron';

// ============================================================================
// Cowork Types
// ============================================================================

/**
 * Cowork message structure
 */
export interface CoworkMessage {
  id: string;
  sessionId: string;
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  content: string;
  metadata?: CoworkMessageMetadata;
  createdAt: number;
  sequence?: number;
}

export interface CoworkMessageMetadata {
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  imageAttachments?: ImageAttachment[];
  [key: string]: unknown;
}

export interface ImageAttachment {
  name: string;
  mimeType: string;
  base64Data: string;
}

/**
 * Permission request from Claude Agent SDK
 */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Permission result
 */
export interface PermissionResult {
  behavior: 'allow' | 'deny' | 'allowOnce';
  updatedInput?: Record<string, unknown>;
}

// ============================================================================
// Scheduled Task Types
// ============================================================================

export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  cronExpression: string;
  workspaceRoot?: string;
  deliveryChannel?: string;
  enabled?: boolean;
  systemPrompt?: string;
}

export interface ScheduledTaskUpdateInput {
  title?: string;
  prompt?: string;
  cronExpression?: string;
  workspaceRoot?: string;
  deliveryChannel?: string;
  enabled?: boolean;
  systemPrompt?: string;
}

// ============================================================================
// MCP (Model Context Protocol) Types
// ============================================================================

export interface McpServerCreateInput {
  name: string;
  description?: string;
  transportType?: 'stdio' | 'sse';
  config: McpServerConfig;
}

export interface McpServerUpdateInput {
  name?: string;
  description?: string;
  transportType?: 'stdio' | 'sse';
  config?: Partial<McpServerConfig>;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  [key: string]: unknown;
}

// ============================================================================
// IM Gateway Types
// ============================================================================

export interface IMStatusChangePayload {
  platform: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  message?: string;
}

export interface IMMessagePayload {
  platform: string;
  messageId: string;
  senderId: string;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// OpenClaw Engine Types
// ============================================================================

export interface OpenClawEngineProgress {
  phase: string;
  progress?: number;
  message?: string;
  error?: string;
}

// ============================================================================
// App Update Types
// ============================================================================

export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  speed?: number;
}

// ============================================================================
// Window State Types
// ============================================================================

export interface WindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

// ============================================================================
// Store Types
// ============================================================================

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ProvidersStore {
  [providerKey: string]: ProviderConfig;
}

export interface AppConfig {
  theme?: 'light' | 'dark' | 'system';
  language?: string;
  useSystemProxy?: boolean;
  [key: string]: unknown;
}

// ============================================================================
// Cowork Config Types
// ============================================================================

export interface CoworkConfig {
  workingDirectory?: string;
  executionMode?: 'auto' | 'local' | 'sandbox';
  agentEngine?: 'openclaw' | 'yd_cowork';
  memoryEnabled?: boolean;
  memoryImplicitUpdateEnabled?: boolean;
  memoryLlmJudgeEnabled?: boolean;
  memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
  memoryUserMemoriesMaxItems?: number;
}

// ============================================================================
// Memory Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  text: string;
  fingerprint: string;
  confidence: number;
  isExplicit: boolean;
  status: 'created' | 'stale' | 'deleted';
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface MemoryListInput {
  query?: string;
  status?: 'created' | 'stale' | 'deleted' | 'all';
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryCreateInput {
  text: string;
  confidence?: number;
  isExplicit?: boolean;
}

export interface MemoryUpdateInput {
  id: string;
  text?: string;
  confidence?: number;
  status?: 'created' | 'stale' | 'deleted';
  isExplicit?: boolean;
}

// ============================================================================
// API Request Types
// ============================================================================

export interface ApiFetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ApiStreamOptions extends ApiFetchOptions {
  requestId: string;
}

// ============================================================================
// Dialog Types
// ============================================================================

export interface DialogFileFilter {
  name: string;
  extensions: string[];
}

export interface SelectFileOptions {
  title?: string;
  filters?: DialogFileFilter[];
}

export interface SaveInlineFileOptions {
  dataBase64: string;
  fileName?: string;
  mimeType?: string;
  cwd?: string;
}

// ============================================================================
// Capture Types
// ============================================================================

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportImageOptions {
  rect: CaptureRect;
  defaultFileName?: string;
}

// ============================================================================
// IPC Event Type Helpers
// ============================================================================

/**
 * Type for IPC handler functions
 */
export type IpcHandler<TArgs extends unknown[], TReturn> = (
  event: IpcMainInvokeEvent,
  ...args: TArgs
) => Promise<TReturn> | TReturn;

/**
 * Type for IPC event callback (renderer side)
 */
export type IpcEventCallback<T> = (data: T) => void;
