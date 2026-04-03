import React from 'react';
// @ts-ignore
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
// @ts-ignore
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface CodeArtifactRendererProps {
  content: string;
  language?: string;
  title: string;
}

const CodeArtifactRenderer: React.FC<CodeArtifactRendererProps> = ({ content, language, title: _title }) => {
  return (
    <div className="w-full h-full overflow-auto">
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        PreTag="div"
        showLineNumbers
        customStyle={{ margin: 0, borderRadius: 0, height: '100%' }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
};

export default CodeArtifactRenderer;
