import React, { createContext, useCallback, useContext, useState } from 'react';

export interface FilePreviewState {
  /** Absolute file path */
  filePath: string;
  /** File content to display */
  content: string;
  /** File extension without dot, e.g. 'md', 'ts', 'html' */
  fileType: string;
  /** Display name (filename only) */
  fileName: string;
}

interface FilePreviewContextValue {
  /** Currently previewed file, or null when panel is closed */
  preview: FilePreviewState | null;
  /** Open the preview panel with file content */
  openPreview: (filePath: string, content: string) => void;
  /** Close the preview panel */
  closePreview: () => void;
}

const FilePreviewContext = createContext<FilePreviewContextValue>({
  preview: null,
  openPreview: () => {},
  closePreview: () => {},
});

/**
 * Extract file extension (lowercase, without dot) from a file path.
 * Returns empty string if no extension found.
 */
const getFileExtension = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const basename = filePath.slice(lastSlash + 1);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return basename.slice(dotIndex + 1).toLowerCase();
};

/**
 * Extract the file name (last segment) from a path.
 */
const getFileName = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return filePath.slice(lastSlash + 1) || filePath;
};

export const FilePreviewProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preview, setPreview] = useState<FilePreviewState | null>(null);

  const openPreview = useCallback((filePath: string, content: string) => {
    setPreview({
      filePath,
      content,
      fileType: getFileExtension(filePath),
      fileName: getFileName(filePath),
    });
  }, []);

  const closePreview = useCallback(() => {
    setPreview(null);
  }, []);

  return (
    <FilePreviewContext.Provider value={{ preview, openPreview, closePreview }}>
      {children}
    </FilePreviewContext.Provider>
  );
};

export const useFilePreview = (): FilePreviewContextValue => useContext(FilePreviewContext);

export default FilePreviewContext;
