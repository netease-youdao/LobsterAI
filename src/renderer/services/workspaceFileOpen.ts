import { type Artifact, type ArtifactType, ArtifactTypeValue } from '../types/artifact';
import { loadDetectedFileArtifact } from './artifactDetection';
import {
  getArtifactTypeFromExtension,
  normalizeFilePathForDedup,
  toAbsoluteArtifactPath,
} from './artifactParser';

export const WorkspaceFileOpenTargetKind = {
  Existing: 'existing',
  Load: 'load',
  ProbeText: 'probe-text',
  System: 'system',
} as const;

export type WorkspaceFileOpenTargetKind =
  typeof WorkspaceFileOpenTargetKind[keyof typeof WorkspaceFileOpenTargetKind];

export type WorkspaceFileOpenTarget =
  | { kind: typeof WorkspaceFileOpenTargetKind.Existing; artifact: Artifact }
  | { kind: typeof WorkspaceFileOpenTargetKind.Load; artifact: Artifact }
  | { kind: typeof WorkspaceFileOpenTargetKind.ProbeText; artifact: Artifact }
  | { kind: typeof WorkspaceFileOpenTargetKind.System; filePath: string };

const LINKED_FILE_ARTIFACT_ID_PREFIX = 'artifact-linked-file-';

const EXTRA_IMAGE_EXTENSIONS = new Set(['.ico', '.tif', '.tiff']);

const EXTRA_MARKDOWN_EXTENSIONS = new Set(['.markdown']);

const EXTRA_TEXT_EXTENSIONS = new Set(['.srt', '.vtt']);

const CODE_EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.xml': 'xml',
  '.plist': 'xml',
  '.xhtml': 'xml',
  '.xsl': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.dart': 'dart',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'html',
  '.mdx': 'markdown',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.hcl': 'hcl',
  '.cmake': 'cmake',
  '.gradle': 'groovy',
  '.groovy': 'groovy',
  '.tex': 'latex',
  '.diff': 'diff',
  '.patch': 'diff',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.properties': 'properties',
  '.env': 'shell',
  '.lock': 'text',
};

const KNOWN_TEXT_FILENAMES: Record<string, { type: ArtifactType; language?: string }> = {
  dockerfile: { type: ArtifactTypeValue.Code, language: 'dockerfile' },
  makefile: { type: ArtifactTypeValue.Code, language: 'makefile' },
  gnumakefile: { type: ArtifactTypeValue.Code, language: 'makefile' },
  cmakelists: { type: ArtifactTypeValue.Code, language: 'cmake' },
  gemfile: { type: ArtifactTypeValue.Code, language: 'ruby' },
  podfile: { type: ArtifactTypeValue.Code, language: 'ruby' },
  rakefile: { type: ArtifactTypeValue.Code, language: 'ruby' },
  fastfile: { type: ArtifactTypeValue.Code, language: 'ruby' },
  vagrantfile: { type: ArtifactTypeValue.Code, language: 'ruby' },
  '.gitignore': { type: ArtifactTypeValue.Code, language: 'text' },
  '.gitattributes': { type: ArtifactTypeValue.Code, language: 'text' },
  '.dockerignore': { type: ArtifactTypeValue.Code, language: 'text' },
  '.editorconfig': { type: ArtifactTypeValue.Code, language: 'ini' },
  '.npmrc': { type: ArtifactTypeValue.Code, language: 'ini' },
  '.nvmrc': { type: ArtifactTypeValue.Code, language: 'text' },
  '.env': { type: ArtifactTypeValue.Code, language: 'shell' },
  '.eslintrc': { type: ArtifactTypeValue.Code, language: 'json' },
  '.prettierrc': { type: ArtifactTypeValue.Code, language: 'json' },
  license: { type: ArtifactTypeValue.Text },
  readme: { type: ArtifactTypeValue.Text },
  changelog: { type: ArtifactTypeValue.Text },
  procfile: { type: ArtifactTypeValue.Code, language: 'yaml' },
};

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.dmg', '.pkg', '.exe', '.msi', '.appimage', '.deb', '.rpm',
  '.dll', '.so', '.dylib', '.o', '.a', '.class', '.jar', '.pyc', '.pyo', '.wasm',
  '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma',
  '.avi', '.mkv', '.wmv', '.flv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.doc', '.ppt', '.key', '.pages', '.numbers',
  '.psd', '.ai', '.sketch', '.fig', '.blend',
]);

function getPathBaseName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return lastSeparator >= 0 ? normalized.slice(lastSeparator + 1) : normalized;
}

function getLowerExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex).toLowerCase();
}

export function isLikelyBinaryText(sample: string): boolean {
  const checkLength = Math.min(sample.length, 8192);
  for (let index = 0; index < checkLength; index += 1) {
    if (sample.charCodeAt(index) === 0) return true;
  }
  return false;
}

export function inferWorkspaceFileArtifactKind(
  fileName: string,
): { type: ArtifactType; language?: string } | 'binary' | 'probe' {
  const lowerName = fileName.toLowerCase();
  if (KNOWN_TEXT_FILENAMES[lowerName]) {
    return KNOWN_TEXT_FILENAMES[lowerName];
  }
  if (lowerName.startsWith('.env.')) {
    return { type: ArtifactTypeValue.Code, language: 'shell' };
  }

  const ext = getLowerExtension(fileName);
  if (!ext) return 'probe';
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) return 'binary';
  if (EXTRA_IMAGE_EXTENSIONS.has(ext)) return { type: ArtifactTypeValue.Image };
  if (EXTRA_MARKDOWN_EXTENSIONS.has(ext)) return { type: ArtifactTypeValue.Markdown };
  if (EXTRA_TEXT_EXTENSIONS.has(ext)) return { type: ArtifactTypeValue.Text };

  const codeLanguage = CODE_EXTENSION_TO_LANGUAGE[ext];
  if (codeLanguage) {
    return { type: ArtifactTypeValue.Code, language: codeLanguage };
  }

  const builtInType = getArtifactTypeFromExtension(ext);
  if (builtInType) {
    return { type: builtInType };
  }

  return 'probe';
}

/**
 * Resolves a file clicked in the Workspace Files browser (or local file picker)
 * into an existing session artifact, an in-app preview artifact (including
 * source code and config files), a text probe, or a system-open fallback.
 */
export function resolveWorkspaceFileOpenTarget(
  filePath: string,
  sessionArtifacts: Artifact[],
  context: { sessionId: string; cwd?: string },
): WorkspaceFileOpenTarget | null {
  const trimmed = filePath.trim();
  if (!trimmed || /[\\/]+$/.test(trimmed)) return null;

  const absolutePath = toAbsoluteArtifactPath(trimmed, context.cwd);
  const fileName = getPathBaseName(absolutePath);
  if (!fileName) return null;

  const pathKey = normalizeFilePathForDedup(absolutePath);
  const existing = sessionArtifacts.find(artifact =>
    artifact.filePath && normalizeFilePathForDedup(artifact.filePath) === pathKey,
  );
  if (existing) {
    return { kind: WorkspaceFileOpenTargetKind.Existing, artifact: existing };
  }

  const inferred = inferWorkspaceFileArtifactKind(fileName);
  if (inferred === 'binary') {
    return { kind: WorkspaceFileOpenTargetKind.System, filePath: absolutePath };
  }

  const baseArtifact: Artifact = {
    id: `${LINKED_FILE_ARTIFACT_ID_PREFIX}${pathKey}`,
    messageId: '',
    sessionId: context.sessionId,
    type: inferred === 'probe' ? ArtifactTypeValue.Code : inferred.type,
    language: inferred === 'probe' ? 'text' : inferred.language,
    title: fileName,
    content: '',
    fileName,
    filePath: absolutePath,
    source: 'file',
    createdAt: Date.now(),
  };

  if (inferred === 'probe') {
    return { kind: WorkspaceFileOpenTargetKind.ProbeText, artifact: baseArtifact };
  }

  return { kind: WorkspaceFileOpenTargetKind.Load, artifact: baseArtifact };
}

export async function loadWorkspaceFileArtifact(
  target: Extract<WorkspaceFileOpenTarget, { kind: typeof WorkspaceFileOpenTargetKind.Load | typeof WorkspaceFileOpenTargetKind.ProbeText }>,
  cwd?: string,
): Promise<Artifact | null> {
  const filePath = target.artifact.filePath;
  if (!filePath) return null;

  const stat = await window.electron?.dialog?.statFile(filePath);
  if (!stat?.success || !stat.isFile) return null;

  if (target.kind === WorkspaceFileOpenTargetKind.ProbeText) {
    const readResult = await window.electron?.dialog?.readTextFile?.(filePath);
    if (!readResult?.success || typeof readResult.content !== 'string') return null;
    if (isLikelyBinaryText(readResult.content)) return null;
    return {
      ...target.artifact,
      content: readResult.truncated ? '' : readResult.content,
      contentVersion: stat.mtimeMs ?? Date.now(),
    };
  }

  if (target.artifact.type === ArtifactTypeValue.Code) {
    return {
      ...target.artifact,
      content: '',
      contentVersion: stat.mtimeMs ?? Date.now(),
    };
  }

  if (target.artifact.type === ArtifactTypeValue.Text) {
    const readResult = await window.electron?.dialog?.readTextFile?.(filePath);
    if (readResult?.success && typeof readResult.content === 'string') {
      return {
        ...target.artifact,
        content: readResult.content,
        contentVersion: stat.mtimeMs ?? Date.now(),
      };
    }
  }

  return loadDetectedFileArtifact(target.artifact, cwd);
}
