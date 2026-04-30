import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Artifact } from '@/types/artifact';

interface ReactRendererProps {
  artifact: Artifact;
  sessionArtifacts?: Artifact[];
}

function resolveCompanionCss(
  jsxSource: string,
  artifact: Artifact,
  sessionArtifacts: Artifact[],
): string {
  const cssBlocks: string[] = [];

  const cssImportRe = /import\s+['"]([^'"]+\.css)['"]\s*;?/g;
  let match: RegExpExecArray | null;

  while ((match = cssImportRe.exec(jsxSource)) !== null) {
    const importPath = match[1];
    const importName = importPath.split('/').pop() || '';

    const cssArtifact = sessionArtifacts.find(
      a => a.fileName === importName && a.content,
    );
    if (cssArtifact) {
      cssBlocks.push(cssArtifact.content);
      continue;
    }

    if (artifact.filePath) {
      const dir = artifact.filePath.substring(0, artifact.filePath.lastIndexOf('/'));
      const resolvedPath = normalizePath(`${dir}/${importPath}`);
      const byPath = sessionArtifacts.find(
        a => a.filePath === resolvedPath && a.content,
      );
      if (byPath) {
        cssBlocks.push(byPath.content);
      }
    }
  }

  return cssBlocks.join('\n');
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return '/' + parts.join('/');
}

function preprocessJsx(source: string): { code: string; componentName: string | null } {
  let code = source;

  // Strip import statements
  code = code.replace(/^\s*import\s+.*?['"][^'"]+['"]\s*;?\s*$/gm, '');

  // Detect default export component name
  let componentName: string | null = null;

  // export default function Foo(
  const fnMatch = code.match(/export\s+default\s+function\s+(\w+)/);
  if (fnMatch) {
    componentName = fnMatch[1];
    code = code.replace(/export\s+default\s+function\s+/, 'function ');
  }

  // export default class Foo
  if (!componentName) {
    const clsMatch = code.match(/export\s+default\s+class\s+(\w+)/);
    if (clsMatch) {
      componentName = clsMatch[1];
      code = code.replace(/export\s+default\s+class\s+/, 'class ');
    }
  }

  // const Foo = ... ; export default Foo;
  if (!componentName) {
    const namedMatch = code.match(/export\s+default\s+(\w+)\s*;?/);
    if (namedMatch) {
      componentName = namedMatch[1];
      code = code.replace(/export\s+default\s+\w+\s*;?/, '');
    }
  }

  // Strip remaining export keywords on declarations
  code = code.replace(/export\s+(?=(?:const|let|var|function|class)\s)/g, '');

  return { code, componentName };
}

function assembleProjectFiles(
  artifact: Artifact,
  sessionArtifacts: Artifact[],
): string {
  const resolved = new Set<string>();
  const codeBlocks: string[] = [];

  const entryId = artifact.id;
  resolved.add(entryId);

  const jsxImportRe = /import\s+(?:(?:\w+|\{[^}]*\})\s+from\s+)?['"]([^'"]+)['"]\s*;?/g;

  function resolveImports(source: string, currentArtifact: Artifact) {
    let match: RegExpExecArray | null;
    const re = new RegExp(jsxImportRe.source, 'g');

    while ((match = re.exec(source)) !== null) {
      const importPath = match[1];

      // Skip CSS imports (handled separately) and package imports
      if (importPath.endsWith('.css') || !importPath.startsWith('.')) continue;

      const importName = importPath.split('/').pop() || '';
      const candidates = [
        importName + '.tsx', importName + '.ts', importName + '.jsx', importName + '.js',
        importName,
      ];

      let found: Artifact | undefined;

      // Try matching by fileName
      for (const candidate of candidates) {
        found = sessionArtifacts.find(
          a => a.id !== entryId && !resolved.has(a.id) && a.fileName === candidate && a.content && a.type === 'react',
        );
        if (found) break;
      }

      // Try matching by relative path resolution
      if (!found && currentArtifact.filePath) {
        const dir = currentArtifact.filePath.substring(0, currentArtifact.filePath.lastIndexOf('/'));
        for (const ext of ['', '.tsx', '.ts', '.jsx', '.js']) {
          const resolvedPath = normalizePath(`${dir}/${importPath}${ext}`);
          found = sessionArtifacts.find(
            a => a.id !== entryId && !resolved.has(a.id) && a.filePath === resolvedPath && a.content,
          );
          if (found) break;
        }
      }

      if (found) {
        resolved.add(found.id);
        const { code } = preprocessJsx(found.content);
        resolveImports(found.content, found);
        codeBlocks.push(code);
      }
    }
  }

  resolveImports(artifact.content, artifact);

  const { code: entryCode } = preprocessJsx(artifact.content);
  codeBlocks.push(entryCode);

  return codeBlocks.join('\n\n');
}

type SandboxState = 'loading' | 'ready' | 'rendered' | 'error';

const SANDBOX_URL = './artifact-react-sandbox.html';

const ReactRenderer: React.FC<ReactRendererProps> = ({ artifact, sessionArtifacts }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [sandboxState, setSandboxState] = useState<SandboxState>('loading');
  const sandboxReadyRef = useRef(false);

  const processed = useMemo(() => {
    const companionCss = sessionArtifacts
      ? resolveCompanionCss(artifact.content, artifact, sessionArtifacts)
      : '';

    const assembledCode = sessionArtifacts
      ? assembleProjectFiles(artifact, sessionArtifacts)
      : preprocessJsx(artifact.content).code;

    const { componentName } = preprocessJsx(artifact.content);

    return { code: assembledCode, componentName: componentName || 'App', companionCss };
  }, [artifact, sessionArtifacts]);

  const sendToSandbox = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !sandboxReadyRef.current) return;
    iframe.contentWindow.postMessage({
      type: 'sandbox:render',
      code: processed.code,
      companionCss: processed.companionCss,
      componentName: processed.componentName,
    }, '*');
  }, [processed]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!event.data || typeof event.data.type !== 'string') return;
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;

      switch (event.data.type) {
        case 'sandbox:ready':
          sandboxReadyRef.current = true;
          setSandboxState('ready');
          sendToSandbox();
          break;
        case 'sandbox:render-success':
          setSandboxState('rendered');
          break;
        case 'sandbox:render-error':
          setSandboxState('error');
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [sendToSandbox]);

  useEffect(() => {
    if (sandboxReadyRef.current) {
      sendToSandbox();
    }
  }, [processed, sendToSandbox]);

  return (
    <div className="w-full h-full relative">
      {sandboxState === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm z-10 bg-background">
          Loading preview...
        </div>
      )}
      <iframe
        ref={iframeRef}
        className="w-full h-full border-0"
        src={SANDBOX_URL}
        sandbox="allow-scripts"
        title={artifact.title}
      />
    </div>
  );
};

export default ReactRenderer;
