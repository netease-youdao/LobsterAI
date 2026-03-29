import React from 'react';

interface HtmlArtifactRendererProps {
  content: string;
  title: string;
}

const HtmlArtifactRenderer: React.FC<HtmlArtifactRendererProps> = ({ content, title }) => {
  // sandbox="allow-scripts" without allow-same-origin prevents the iframe from
  // accessing the parent page's DOM or IPC bridge. contentDocument access will
  // throw due to cross-origin restrictions, so auto-height detection is not possible.
  // The iframe fills the panel height via absolute positioning.
  return (
    <div className="relative w-full h-full">
      <iframe
        sandbox="allow-scripts"
        srcDoc={content}
        className="absolute inset-0 w-full h-full border-0"
        title={title}
      />
    </div>
  );
};

export default HtmlArtifactRenderer;
