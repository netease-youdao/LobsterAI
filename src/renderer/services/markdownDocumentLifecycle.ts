interface MarkdownDocumentsLifecycle {
  flush: () => Promise<void>;
  hasUnsafeEdits: () => boolean;
}

/** The window owns this guard; closing an editor must not remove it. */
export function installMarkdownDocumentLifecycle(
  target: Window,
  documents: MarkdownDocumentsLifecycle,
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
