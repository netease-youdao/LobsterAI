import React, { useMemo } from 'react';

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

  // Match relative CSS imports: import './App.css', import '../styles.css', etc.
  const cssImportRe = /import\s+['"]([^'"]+\.css)['"]\s*;?/g;
  let match: RegExpExecArray | null;

  while ((match = cssImportRe.exec(jsxSource)) !== null) {
    const importPath = match[1];
    const importName = importPath.split('/').pop() || '';

    // Find a matching CSS artifact by fileName
    const cssArtifact = sessionArtifacts.find(
      a => a.fileName === importName && a.content,
    );
    if (cssArtifact) {
      cssBlocks.push(cssArtifact.content);
      continue;
    }

    // Try matching by resolving relative to the artifact's own directory
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

function escapeForScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/<\//g, '<\\/');
}

function buildReactIframeHtml(jsxSource: string, companionCss: string): string {
  const { code, componentName } = preprocessJsx(jsxSource);

  const renderTarget = componentName || 'App';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }
    #root { min-height: 100vh; }
    .react-render-error { color: #ef4444; padding: 16px; font-family: monospace; white-space: pre-wrap; }
  </style>
  ${companionCss ? `<style>${escapeForScript(companionCss)}<\/style>` : ''}
  <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"><\/script>
  <script>
    // Expose React APIs as globals so stripped imports still work
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useMemo = React.useMemo;
    var useCallback = React.useCallback;
    var useContext = React.useContext;
    var useReducer = React.useReducer;
    var useLayoutEffect = React.useLayoutEffect;
    var useId = React.useId;
    var createContext = React.createContext;
    var Fragment = React.Fragment;
    var createElement = React.createElement;
    var cloneElement = React.cloneElement;
    var forwardRef = React.forwardRef;
    var memo = React.memo;
    var lazy = React.lazy;
    var Suspense = React.Suspense;
    var StrictMode = React.StrictMode;
    var Children = React.Children;
    var createRef = React.createRef;
    var isValidElement = React.isValidElement;
  <\/script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    try {
      ${escapeForScript(code)}

      var __Component__ = (typeof ${renderTarget} !== 'undefined') ? ${renderTarget} : null;
      if (__Component__) {
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(__Component__));
      } else {
        document.getElementById('root').innerHTML =
          '<div class="react-render-error">Component "${renderTarget}" not found</div>';
      }
    } catch (err) {
      document.getElementById('root').innerHTML =
        '<div class="react-render-error">' + err.message + '<\\/div>';
    }
  <\/script>
</body>
</html>`;
}

const ReactRenderer: React.FC<ReactRendererProps> = ({ artifact, sessionArtifacts }) => {
  const iframeHtml = useMemo(() => {
    const companionCss = sessionArtifacts
      ? resolveCompanionCss(artifact.content, artifact, sessionArtifacts)
      : '';
    return buildReactIframeHtml(artifact.content, companionCss);
  }, [artifact.content, artifact.filePath, sessionArtifacts]);

  return (
    <iframe
      className="w-full h-full border-0"
      srcDoc={iframeHtml}
      sandbox="allow-scripts"
      title={artifact.title}
    />
  );
};

export default ReactRenderer;
