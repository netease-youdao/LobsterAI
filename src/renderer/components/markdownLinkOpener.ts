import { createContext, useContext } from 'react';

/**
 * Lets the view hosting rendered markdown open its links inside the app, the
 * way that view's own artifact cards open. Without a provider, links keep
 * going to the system default application or browser.
 */
export interface MarkdownLinkOpener {
  /** Resolves false when the app cannot show the file, leaving it to the system default app. */
  openLocalFile: (filePath: string) => Promise<boolean>;
  /** Returns false when the link belongs in the system browser. */
  openWebLink: (url: string) => boolean;
}

export const MarkdownLinkOpenerContext = createContext<MarkdownLinkOpener | null>(null);

export const useMarkdownLinkOpener = (): MarkdownLinkOpener | null => useContext(MarkdownLinkOpenerContext);
