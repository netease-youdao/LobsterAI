import React, { useEffect, useRef, useState } from 'react';

import type { Artifact } from '@/types/artifact';

interface HtmlRendererProps {
  artifact: Artifact;
}

const HASH_NAV_INTERCEPTOR = `<script>document.addEventListener('click',function(e){var a=e.target&&(e.target.closest?e.target.closest('a'):e.target);if(!a||a.tagName!=='A')return;var h=a.getAttribute('href');if(!h||h.charAt(0)!=='#')return;e.preventDefault();var id=h.slice(1);if(!id){window.scrollTo({top:0,behavior:'smooth'});return;}var el=document.getElementById(id)||document.querySelector('[name="'+id+'"]');if(el)el.scrollIntoView({behavior:'smooth'});});</script>`;

function injectHashNavInterceptor(html: string): string {
  if (html.includes('</body>')) {
    return html.replace('</body>', HASH_NAV_INTERCEPTOR + '</body>');
  }
  if (html.includes('</html>')) {
    return html.replace('</html>', HASH_NAV_INTERCEPTOR + '</html>');
  }
  return html + HASH_NAV_INTERCEPTOR;
}

/**
 * File-based HTML: served via local HTTP server for full Chrome-like fidelity.
 */
const FileBasedHtmlRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!artifact.filePath) return;

    let cancelled = false;

    const setupSession = async () => {
      try {
        const result = await window.electron.artifact.createPreviewSession(artifact.filePath!, artifact.fileAccess);
        if (cancelled) {
          if (result.success && result.sessionId) {
            void window.electron.artifact.destroyPreviewSession(result.sessionId);
          }
          return;
        }
        if (result.success && result.url && result.sessionId) {
          sessionIdRef.current = result.sessionId;
          setPreviewUrl(result.url);
          setError(null);
        } else {
          setError(result.error || 'Failed to create preview session');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to create preview session');
        }
      }
    };

    setupSession();

    return () => {
      cancelled = true;
      if (sessionIdRef.current) {
        window.electron.artifact.destroyPreviewSession(sessionIdRef.current);
        sessionIdRef.current = null;
      }
    };
  }, [artifact.fileAccess, artifact.filePath]);

  // Reload iframe when file content changes (triggered by file watcher)
  const contentVersion = artifact.contentVersion ?? artifact.content;
  const prevContentRef = useRef(contentVersion);
  useEffect(() => {
    if (prevContentRef.current === contentVersion) return;
    prevContentRef.current = contentVersion;
    if (!iframeRef.current) return;
    try {
      iframeRef.current.contentWindow?.location.reload();
    } catch {
      // Cross-origin reload fallback: reset src with cache-busting
      if (previewUrl) {
        const url = new URL(previewUrl);
        url.searchParams.set('_t', String(Date.now()));
        iframeRef.current.src = url.toString();
      }
    }
  }, [contentVersion, previewUrl]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        {error}
      </div>
    );
  }

  if (!previewUrl) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading...
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={previewUrl}
      className="w-full h-full border-0"
      title={artifact.title}
    />
  );
};

/**
 * Inline HTML (AI-generated): rendered via srcDoc with sandbox for security.
 */
const InlineHtmlRenderer: React.FC<{ artifact: Artifact }> = ({ artifact }) => {
  const html = artifact.content;
  if (!html) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm">
        Loading...
      </div>
    );
  }

  const finalHtml = injectHashNavInterceptor(html);
  return (
    <iframe
      srcDoc={finalHtml}
      className="w-full h-full border-0"
      sandbox="allow-scripts"
      title={artifact.title}
    />
  );
};

const HtmlRenderer: React.FC<HtmlRendererProps> = ({ artifact }) => {
  if (artifact.filePath) {
    return <FileBasedHtmlRenderer artifact={artifact} />;
  }
  return <InlineHtmlRenderer artifact={artifact} />;
};

export default HtmlRenderer;
