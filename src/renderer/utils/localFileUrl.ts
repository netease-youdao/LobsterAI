export const toLocalFileUrl = (filePath: string): string => {
  const normalizedPath = filePath.trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return '';
  }

  const pathname = /^[A-Za-z]:/.test(normalizedPath)
    ? `/${normalizedPath}`
    : normalizedPath.startsWith('/')
      ? normalizedPath
      : `/${normalizedPath}`;

  return `localfile://${encodeURI(pathname)}`;
};
