import React from 'react';

// ============================================================
// Individual file-type SVG icon components
// All icons: 24×24 viewBox
// ============================================================

interface IconProps {
  className?: string;
}

/** Word document icon — blue "W" badge */
export const WordIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" />
    <text x="12" y="16" textAnchor="middle" fill="#FFFFFF" fontSize="11.5" fontWeight="700" fontFamily="system-ui, -apple-system, Arial, sans-serif">W</text>
  </svg>
);

/** Excel spreadsheet icon — green "X" badge */
export const ExcelIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" />
    <text x="12" y="16" textAnchor="middle" fill="#FFFFFF" fontSize="11.5" fontWeight="700" fontFamily="system-ui, -apple-system, Arial, sans-serif">X</text>
  </svg>
);

/** PowerPoint presentation icon — orange-red "P" badge */
export const PptIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" />
    <text x="12" y="16" textAnchor="middle" fill="#FFFFFF" fontSize="11.5" fontWeight="700" fontFamily="system-ui, -apple-system, Arial, sans-serif">P</text>
  </svg>
);

/** PDF document icon — red "PDF" label on a document shape */
export const PdfIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    <text x="12" y="17" textAnchor="middle" fill="currentColor" stroke="none" fontSize="5.5" fontWeight="bold" fontFamily="Arial, sans-serif">PDF</text>
  </svg>
);

/** JavaScript badge icon — yellow rounded square with "JS" */
export const JavaScriptFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="#F0DB4F" />
    <text x="14.2" y="17.5" textAnchor="middle" fill="#1F2937" fontSize="9.5" fontWeight="800" fontFamily="system-ui, -apple-system, Arial, sans-serif">JS</text>
  </svg>
);

/** TypeScript badge icon — blue rounded square with "TS" */
export const TypeScriptFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="#3178C6" />
    <text x="14.2" y="17.5" textAnchor="middle" fill="#FFFFFF" fontSize="9.5" fontWeight="800" fontFamily="system-ui, -apple-system, Arial, sans-serif">TS</text>
  </svg>
);

/** Python icon — classic two-tone blue/yellow emblem */
export const PythonFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <path
      d="M11.9 3C7.9 3 8.2 4.7 8.2 4.7v2.4h3.9v.8H6.6S4 7.6 4 11.7s2.3 3.9 2.3 3.9h1.4v-2s-.1-2.3 2.2-2.3h3.9s2.1 0 2.1-2.1V5.5S16.2 3 11.9 3Zm-2.1 1.5a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z"
      fill="#3776AB"
    />
    <path
      d="M12.1 21c4 0 3.7-1.7 3.7-1.7v-2.4h-3.9v-.8h5.5s2.6.3 2.6-3.8-2.3-3.9-2.3-3.9h-1.4v2s.1 2.3-2.2 2.3h-3.9s-2.1 0-2.1 2.1v3.7S7.8 21 12.1 21Zm2.1-1.5a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Z"
      fill="#FFD43B"
    />
  </svg>
);

/** Archive / compressed file icon */
export const ArchiveIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
  </svg>
);

/** Source code file icon — angle brackets */
export const CodeFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
  </svg>
);

/** Plain text / config file icon */
export const TextFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
  </svg>
);

/** Audio file icon — musical note */
export const AudioFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
  </svg>
);

/** Video file icon — play/film */
export const VideoFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0118 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0118 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 016 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m14.25 0h1.5" />
  </svg>
);

/** Image file icon — rounded landscape badge */
export const ImageFileIcon: React.FC<IconProps> = ({ className }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor" />
    <circle cx="9" cy="9.25" r="1.6" fill="#FFFFFF" />
    <path d="M5.5 17.5l4.2-4.6a1.1 1.1 0 0 1 1.62-.02l2.18 2.34 1.88-2.04a1.1 1.1 0 0 1 1.62.02l1.5 1.72V17.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" fill="#FFFFFF" />
  </svg>
);

// ============================================================
// File extension → type info mapping
// ============================================================

export interface FileTypeInfo {
  icon: React.FC<IconProps>;
  color: string;
  label: string;
}

const EXT_MAP: Record<string, FileTypeInfo> = {};

const register = (extensions: string[], info: FileTypeInfo) => {
  for (const ext of extensions) {
    EXT_MAP[ext] = info;
  }
};

// Word
register(['.doc', '.docx'], { icon: WordIcon, color: '#2B579A', label: 'Word' });
// Excel
register(['.xls', '.xlsx', '.csv', '.tsv'], { icon: ExcelIcon, color: '#217346', label: 'Excel' });
// PPT
register(['.ppt', '.pptx'], { icon: PptIcon, color: '#D24726', label: 'PPT' });
// PDF
register(['.pdf'], { icon: PdfIcon, color: '#FF0000', label: 'PDF' });
// Archive
register(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'], { icon: ArchiveIcon, color: '#F59E0B', label: 'Archive' });
// JavaScript
register(['.js', '.mjs', '.cjs', '.jsx'], { icon: JavaScriptFileIcon, color: '#EAB308', label: 'JavaScript' });
// TypeScript
register(['.ts', '.mts', '.cts', '.tsx'], { icon: TypeScriptFileIcon, color: '#3178C6', label: 'TypeScript' });
// Python
register(['.py', '.pyi', '.pyw'], { icon: PythonFileIcon, color: '#3776AB', label: 'Python' });
// Code
register([
  '.java', '.go', '.rs', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.cs',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xml', '.plist',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.rb', '.php', '.swift', '.kt', '.kts', '.lua', '.r', '.scala', '.dart',
  '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte', '.astro',
  '.tf', '.hcl', '.cmake', '.gradle', '.groovy', '.zig', '.m', '.mm',
], { icon: CodeFileIcon, color: '#8B5CF6', label: 'Code' });
// Text / Config
register([
  '.txt', '.md', '.markdown', '.mdx', '.log', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env',
  '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.npmrc',
  '.lock', '.diff', '.patch',
], { icon: TextFileIcon, color: '#6B7280', label: 'Text' });
// Subtitle
register(['.srt'], { icon: TextFileIcon, color: '#6B7280', label: 'SRT' });
register(['.vtt'], { icon: TextFileIcon, color: '#6B7280', label: 'VTT' });
// Audio
register(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.wma'], { icon: AudioFileIcon, color: '#EC4899', label: 'Audio' });
// Video
register(['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm'], { icon: VideoFileIcon, color: '#6366F1', label: 'Video' });
// Image (fallback — used when thumbnail rendering fails)
register(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.ico', '.avif'], { icon: ImageFileIcon, color: '#7C3AED', label: 'Image' });

const KNOWN_CODE_FILENAMES = new Set(['dockerfile', 'makefile', 'gnumakefile', 'gemfile', 'rakefile', 'podfile']);

/** Default info for unrecognized file types */
const DEFAULT_FILE_TYPE_INFO: FileTypeInfo = { icon: TextFileIcon, color: '#9CA3AF', label: 'File' };

/**
 * Get file type icon info from a file name.
 * Extension matching is case-insensitive.
 */
export function getFileTypeInfo(fileName: string): FileTypeInfo {
  const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
  if (KNOWN_CODE_FILENAMES.has(baseName.toLowerCase())) {
    return { icon: CodeFileIcon, color: '#8B5CF6', label: 'Code' };
  }
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex === -1) return DEFAULT_FILE_TYPE_INFO;
  const ext = baseName.slice(dotIndex).toLowerCase();
  return EXT_MAP[ext] || DEFAULT_FILE_TYPE_INFO;
}
