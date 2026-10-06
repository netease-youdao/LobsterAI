const TEXT_FILE_EXTENSIONS = new Set([
  '.bat', '.c', '.cfg', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.gradle',
  '.h', '.html', '.ini', '.java', '.js', '.json', '.jsonl', '.jsx', '.kt', '.log',
  '.md', '.php', '.properties', '.py', '.rb', '.rs', '.sh', '.sql', '.srt', '.swift',
  '.toml', '.ts', '.tsv', '.tsx', '.txt', '.vtt', '.xml', '.yaml', '.yml',
]);

const TEXT_FILE_NAMES = new Set([
  '.gitignore', '.npmrc', '.prettierrc', 'dockerfile', 'makefile', 'readme',
]);

export const canCopyLocalFileAsText = (fileName: string): boolean => {
  const normalizedName = fileName.trim().toLowerCase();
  if (!normalizedName) return false;
  if (TEXT_FILE_NAMES.has(normalizedName)) return true;
  const dotIndex = normalizedName.lastIndexOf('.');
  return dotIndex >= 0 && TEXT_FILE_EXTENSIONS.has(normalizedName.slice(dotIndex));
};
