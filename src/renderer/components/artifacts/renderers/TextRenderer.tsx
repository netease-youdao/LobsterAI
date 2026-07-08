import React, { useEffect, useMemo, useState } from 'react';

import { i18nService } from '@/services/i18n';
import type { Artifact } from '@/types/artifact';

import { CoworkSelectedTextSource } from '../../../../shared/cowork/selectedText';
import {
  type ArtifactSelectedTextContext,
  useArtifactSelectedTextAction,
} from '../artifactSelectedText';

const t = (key: string) => i18nService.t(key);

function useIsDark() {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function detectCsv(content: string, fileName?: string): boolean {
  if (fileName?.endsWith('.csv')) return true;
  const lines = content.split('\n').slice(0, 5);
  if (lines.length < 2) return false;
  const commaCount = lines[0].split(',').length;
  return commaCount >= 2 && lines.slice(1).every(l => l.split(',').length === commaCount || l.trim() === '');
}

function parseCsv(content: string): string[][] {
  return content.split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.split(',').map(cell => cell.trim()));
}

interface TextRendererProps {
  artifact: Artifact;
  selectedTextContext?: ArtifactSelectedTextContext;
}

const TextRenderer: React.FC<TextRendererProps> = ({ artifact, selectedTextContext }) => {
  const isDark = useIsDark();
  const [showTable, setShowTable] = useState(false);
  const { actionButton, containerRef, handleMouseUp } = useArtifactSelectedTextAction({
    artifact,
    sourceType: CoworkSelectedTextSource.ArtifactText,
    selectedTextContext: showTable ? undefined : selectedTextContext,
  });

  const isCsv = useMemo(
    () => detectCsv(artifact.content, artifact.fileName),
    [artifact.content, artifact.fileName]
  );

  const csvData = useMemo(
    () => (isCsv && showTable) ? parseCsv(artifact.content) : null,
    [isCsv, showTable, artifact.content]
  );

  if (!artifact.content) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        No content
      </div>
    );
  }

  const lines = artifact.content.split('\n');
  const lineNumWidth = String(lines.length).length;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {isCsv && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border shrink-0">
          <button
            onClick={() => setShowTable(!showTable)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              showTable
                ? 'bg-primary/10 text-primary'
                : 'text-secondary hover:text-foreground hover:bg-surface'
            }`}
          >
            {showTable ? t('artifactTextView') : t('artifactTableView')}
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        onMouseUp={handleMouseUp}
        className="relative flex-1 overflow-auto"
      >
        {actionButton}
        {showTable && csvData ? (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                {csvData[0]?.map((cell, i) => (
                  <th
                    key={i}
                    className={`px-3 py-1.5 text-left font-medium border-b border-border sticky top-0 ${
                      isDark ? 'bg-[#282c34] text-[#abb2bf]' : 'bg-[#f0f2f5] text-[#383a42]'
                    }`}
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {csvData.slice(1).map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? '' : (isDark ? 'bg-white/[0.02]' : 'bg-black/[0.02]')}>
                  {row.map((cell, ci) => (
                    <td key={ci} className="px-3 py-1 border-b border-border/50 whitespace-nowrap">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <pre className={`text-code font-mono p-4 m-0 whitespace-pre-wrap break-words min-h-full ${
            isDark ? 'bg-[#282c34] text-[#abb2bf]' : 'bg-[#f0f2f5] text-[#383a42]'
          }`}>
            {lines.map((line, i) => (
              <span key={i} className="flex">
                <span className="select-none text-muted/50 pr-4 text-right inline-block" style={{ minWidth: `${lineNumWidth + 1}ch` }}>
                  {i + 1}
                </span>
                <span className="flex-1">{line}{'\n'}</span>
              </span>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
};

export default TextRenderer;
