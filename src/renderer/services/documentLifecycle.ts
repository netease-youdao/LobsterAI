/** The open documents of one editor kind (Markdown, Word, Excel, ...). */
interface DocumentsLifecycle {
  flush: () => Promise<void>;
  hasUnsafeEdits: () => boolean;
}

/**
 * Saves open documents when the window loses focus or unloads, and asks before closing it while
 * edits are not safely on disk. The window owns this guard; closing an editor must not remove it.
 */
export function installDocumentLifecycle(
  target: Window,
  documents: DocumentsLifecycle,
): () => void {
  const flush = () => { void documents.flush(); };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    flush();
    if (documents.hasUnsafeEdits()) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  target.addEventListener('blur', flush);
  target.addEventListener('pagehide', flush);
  target.addEventListener('beforeunload', beforeUnload);
  return () => {
    target.removeEventListener('blur', flush);
    target.removeEventListener('pagehide', flush);
    target.removeEventListener('beforeunload', beforeUnload);
  };
}
