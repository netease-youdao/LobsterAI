/**
 * IPC Payload Sanitizers
 * 
 * This module provides utilities for sanitizing data before sending through IPC channels.
 * It prevents memory issues from large payloads and handles circular references.
 */

// Configuration constants
export const IPC_CONFIG = {
  MESSAGE_CONTENT_MAX_CHARS: 120_000,
  UPDATE_CONTENT_MAX_CHARS: 120_000,
  STRING_MAX_CHARS: 4_000,
  MAX_DEPTH: 5,
  MAX_KEYS: 80,
  MAX_ITEMS: 40,
} as const;

/**
 * Truncate a string to max length with indicator
 */
export const truncateIpcString = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated in main IPC forwarding]`;
};

/**
 * Recursively sanitize any payload for safe IPC transmission.
 * - Truncates long strings
 * - Limits object depth and key count
 * - Limits array length
 * - Handles circular references
 */
export const sanitizeIpcPayload = (
  value: unknown,
  depth = 0,
  seen?: WeakSet<object>
): unknown => {
  const localSeen = seen ?? new WeakSet<object>();

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateIpcString(value, IPC_CONFIG.STRING_MAX_CHARS);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return '[function]';
  }

  if (depth >= IPC_CONFIG.MAX_DEPTH) {
    return '[truncated-depth]';
  }

  if (Array.isArray(value)) {
    const result = value
      .slice(0, IPC_CONFIG.MAX_ITEMS)
      .map((entry) => sanitizeIpcPayload(entry, depth + 1, localSeen));
    if (value.length > IPC_CONFIG.MAX_ITEMS) {
      result.push(`[truncated-items:${value.length - IPC_CONFIG.MAX_ITEMS}]`);
    }
    return result;
  }

  if (typeof value === 'object') {
    if (localSeen.has(value as object)) {
      return '[circular]';
    }
    localSeen.add(value as object);

    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};

    for (const [key, entry] of entries.slice(0, IPC_CONFIG.MAX_KEYS)) {
      result[key] = sanitizeIpcPayload(entry, depth + 1, localSeen);
    }

    if (entries.length > IPC_CONFIG.MAX_KEYS) {
      result.__truncated_keys__ = entries.length - IPC_CONFIG.MAX_KEYS;
    }

    return result;
  }

  return String(value);
};

/**
 * Sanitize a Cowork message for IPC transmission.
 * Preserves imageAttachments in metadata as-is (base64 data can be very large
 * and must not be truncated by the generic sanitizer).
 */
export const sanitizeCoworkMessageForIpc = (message: any): any => {
  if (!message || typeof message !== 'object') {
    return message;
  }

  let sanitizedMetadata: unknown;
  if (message.metadata && typeof message.metadata === 'object') {
    const { imageAttachments, ...rest } = message.metadata as Record<string, unknown>;
    const sanitizedRest = sanitizeIpcPayload(rest) as Record<string, unknown> | undefined;
    sanitizedMetadata = {
      ...(sanitizedRest && typeof sanitizedRest === 'object' ? sanitizedRest : {}),
      ...(Array.isArray(imageAttachments) && imageAttachments.length > 0
        ? { imageAttachments }
        : {}),
    };
  } else {
    sanitizedMetadata = undefined;
  }

  return {
    ...message,
    content:
      typeof message.content === 'string'
        ? truncateIpcString(message.content, IPC_CONFIG.MESSAGE_CONTENT_MAX_CHARS)
        : '',
    metadata: sanitizedMetadata,
  };
};

/**
 * Sanitize a permission request for IPC transmission.
 */
export const sanitizePermissionRequestForIpc = (request: any): any => {
  if (!request || typeof request !== 'object') {
    return request;
  }
  return {
    ...request,
    toolInput: sanitizeIpcPayload(request.toolInput ?? {}),
  };
};
