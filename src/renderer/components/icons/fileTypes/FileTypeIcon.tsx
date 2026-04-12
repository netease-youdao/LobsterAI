import React from 'react';
import { getFileTypeInfo } from '.';

interface FileTypeIconProps {
  fileName: string;
  className?: string;
}

/**
 * Renders the appropriate file-type icon for the given file name.
 * Wraps the icon in a span that applies the category-specific color.
 */
const FileTypeIcon: React.FC<FileTypeIconProps> = ({ fileName, className }) => {
  const { icon: Icon, color } = getFileTypeInfo(fileName);
  return (
    <span style={{ color }}>
      <Icon className={className} />
    </span>
  );
};

export default FileTypeIcon;