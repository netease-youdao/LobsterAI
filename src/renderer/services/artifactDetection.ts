import { type Artifact, ArtifactTypeValue } from '../types/artifact';
import type { CoworkMessage } from '../types/cowork';
import {
  isIgnoredArtifactPath,
  isPathInsideDirectory,
  normalizeFilePathForDedup,
  parseFileLinksFromMessage,
  parseFilePathsFromText,
  parseMediaTokensFromText,
  parseRemoteImageArtifactsFromText,
  parseToolArtifact,
  parseToolResultMediaArtifacts,
  shouldParseFilePathsFromToolResult,
  stripFileLinksFromText,
  toAbsoluteArtifactPath,
} from './artifactParser';
import { parseLocalServiceArtifactsFromMessages } from './localServiceContextParser';

/**
 * Detect artifacts from a session transcript.
 *
 * Detection signals, by trust level:
 * - Tool input paths (write/edit tools) and markdown file links are treated
 *   as intentional signals: kept wherever they point, unless the path is in
 *   an ignored directory (.cowork-temp, node_modules, hidden dirs).
 * - Bare file paths in message text are low-trust: they must additionally be
 *   inside the session working directory.
 * - Media signals (MEDIA: tokens, tool media assets, image-gen tool result
 *   paths) are curated outputs and bypass the directory filters.
 *
 * File paths are resolved to absolute paths (against `cwd`) at collection
 * time so artifacts from different signals dedupe against each other.
 * Existence checks happen later in loadDetectedFileArtifact.
 */
export function collectSessionArtifacts(
  messages: CoworkMessage[],
  sessionId: string,
  cwd?: string,
): Artifact[] {
  const detected = parseLocalServiceArtifactsFromMessages(
    messages,
    sessionId,
    { workingDirectory: cwd },
  );

  const absolutize = (artifact: Artifact): Artifact =>
    artifact.filePath
      ? { ...artifact, filePath: toAbsoluteArtifactPath(artifact.filePath, cwd) }
      : artifact;

  const pushFileArtifactIfNew = (artifact: Artifact, seenFilePaths: Set<string>) => {
    const normalized = artifact.filePath ? normalizeFilePathForDedup(artifact.filePath) : '';
    if (!artifact.filePath || seenFilePaths.has(normalized)) return;
    seenFilePaths.add(normalized);
    detected.push(artifact);
  };
  // Intentional signals (markdown links, write/edit tool inputs): no cwd
  // containment so "save to Desktop"-style deliverables still surface.
  const pushLinkedFileArtifact = (artifact: Artifact, seenFilePaths: Set<string>) => {
    const resolved = absolutize(artifact);
    if (!resolved.filePath || isIgnoredArtifactPath(resolved.filePath)) return;
    pushFileArtifactIfNew(resolved, seenFilePaths);
  };
  // Low-trust signals (bare paths in prose): must live inside the session cwd.
  const pushBarePathArtifact = (artifact: Artifact, seenFilePaths: Set<string>) => {
    const resolved = absolutize(artifact);
    if (!resolved.filePath || isIgnoredArtifactPath(resolved.filePath)) return;
    if (cwd?.trim() && !isPathInsideDirectory(resolved.filePath, cwd)) return;
    pushFileArtifactIfNew(resolved, seenFilePaths);
  };
  // Curated media outputs: no directory filtering (may live in app data dirs).
  const pushMediaFileArtifact = (artifact: Artifact, seenFilePaths: Set<string>) => {
    pushFileArtifactIfNew(absolutize(artifact), seenFilePaths);
  };
  for (const msg of messages) {
    if (msg.type === 'assistant' && !msg.metadata?.isThinking && msg.content) {
      const seenFilePaths = new Set<string>();
      const fileLinks = parseFileLinksFromMessage(msg.content, msg.id, sessionId);
      for (const fl of fileLinks) {
        pushLinkedFileArtifact(fl, seenFilePaths);
      }

      const contentWithoutFileLinks = stripFileLinksFromText(msg.content);
      const pathArtifacts = parseFilePathsFromText(contentWithoutFileLinks, msg.id, sessionId);
      for (const pa of pathArtifacts) {
        pushBarePathArtifact(pa, seenFilePaths);
      }

      detected.push(...parseRemoteImageArtifactsFromText(msg.content, msg.id, sessionId, 'artifact-remote-assistant'));
    }

    if (msg.type === 'tool_result') {
      const seenFilePaths = new Set<string>();
      const toolMediaArtifacts = parseToolResultMediaArtifacts(msg, sessionId);
      if (toolMediaArtifacts.length > 0) {
        for (const mediaArtifact of toolMediaArtifacts) {
          if (mediaArtifact.filePath) {
            pushMediaFileArtifact(mediaArtifact, seenFilePaths);
          } else {
            detected.push(mediaArtifact);
          }
        }
        continue;
      }

      if (!msg.content) continue;

      const mediaArtifacts = parseMediaTokensFromText(msg.content, msg.id, sessionId);
      for (const ma of mediaArtifacts) {
        pushMediaFileArtifact(ma, seenFilePaths);
      }

      // Only parse bare file paths from tool results of image generation tools.
      // Other tools (e.g. Bash running `find`) may output many file paths in their
      // results that should NOT become artifacts.
      const toolUseId = msg.metadata?.toolUseId;
      const pairedToolUse = toolUseId
        ? messages.find(m => m.type === 'tool_use' && m.metadata?.toolUseId === toolUseId)
        : undefined;
      const toolName = pairedToolUse?.metadata?.toolName
        ? String(pairedToolUse.metadata.toolName)
        : '';
      if (shouldParseFilePathsFromToolResult(toolName)) {
        const pathArtifacts = parseFilePathsFromText(msg.content, msg.id, sessionId, 'artifact-toolresult');
        for (const pa of pathArtifacts) {
          pushMediaFileArtifact(pa, seenFilePaths);
        }
      }
      detected.push(...parseRemoteImageArtifactsFromText(msg.content, msg.id, sessionId, 'artifact-remote-toolresult'));
    }

    if (msg.type === 'system') {
      const seenFilePaths = new Set<string>();
      const toolMediaArtifacts = parseToolResultMediaArtifacts(msg, sessionId);
      if (toolMediaArtifacts.length > 0) {
        for (const mediaArtifact of toolMediaArtifacts) {
          if (mediaArtifact.filePath) {
            pushMediaFileArtifact(mediaArtifact, seenFilePaths);
          } else {
            detected.push(mediaArtifact);
          }
        }
        continue;
      }

      if (!msg.content) continue;

      const fileLinks = parseFileLinksFromMessage(msg.content, msg.id, sessionId);
      for (const fl of fileLinks) {
        pushLinkedFileArtifact(fl, seenFilePaths);
      }

      const contentWithoutFileLinks = stripFileLinksFromText(msg.content);
      const pathArtifacts = parseFilePathsFromText(contentWithoutFileLinks, msg.id, sessionId, 'artifact-system-path');
      for (const pa of pathArtifacts) {
        pushBarePathArtifact(pa, seenFilePaths);
      }

      detected.push(...parseRemoteImageArtifactsFromText(msg.content, msg.id, sessionId, 'artifact-remote-system'));
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === 'tool_use') {
      const toolUseId = msg.metadata?.toolUseId;
      const toolResult = toolUseId
        ? messages.find(m => m.type === 'tool_result' && m.metadata?.toolUseId === toolUseId)
        : messages[i + 1]?.type === 'tool_result' ? messages[i + 1] : undefined;
      const toolArtifact = parseToolArtifact(msg, toolResult, sessionId);
      if (toolArtifact && toolArtifact.filePath) {
        const resolved = absolutize(toolArtifact);
        if (resolved.filePath && !isIgnoredArtifactPath(resolved.filePath)) {
          detected.push(resolved);
        }
      }
    }
  }

  return detected;
}

/**
 * Resolve a detected file artifact against disk: verify the file exists and
 * hydrate its content, returning the display-ready artifact or null when the
 * file is missing/unreadable. Videos are returned without reading (players
 * stream from the file path directly).
 */
export async function loadDetectedFileArtifact(
  artifact: Artifact,
  cwd?: string,
): Promise<Artifact | null> {
  if (!artifact.filePath) return null;
  const absPath = toAbsoluteArtifactPath(artifact.filePath, cwd);

  if (artifact.type === ArtifactTypeValue.Video) {
    return { ...artifact, content: '', filePath: absPath };
  }

  if (artifact.type === ArtifactTypeValue.Html) {
    try {
      const stat = await window.electron.dialog.statFile(absPath);
      if (stat?.success && stat.isFile) {
        return { ...artifact, content: '', filePath: absPath, contentVersion: Date.now() };
      }
    } catch {
      // File unreadable or missing.
    }
    return null;
  }

  try {
    const result = await window.electron.dialog.readFileAsDataUrl(absPath);
    if (result?.success && result.dataUrl) {
      const isTextType = artifact.type !== ArtifactTypeValue.Image && artifact.type !== ArtifactTypeValue.Document;
      let content = result.dataUrl;
      if (isTextType) {
        try {
          const base64 = result.dataUrl.split(',')[1] || '';
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
          content = new TextDecoder('utf-8').decode(bytes);
        } catch {
          content = result.dataUrl;
        }
      }
      return { ...artifact, content, filePath: absPath };
    }
  } catch {
    // File unreadable or missing.
  }
  return null;
}
