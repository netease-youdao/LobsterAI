import { useEffect, useState } from 'react';

/** Whether the main window is in full screen; updates as the user enters or leaves it. */
export const useIsWindowFullscreen = (): boolean => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let disposed = false;
    const windowApi = window.electron?.window;
    // State broadcasts only fire on changes, so read the current value once on mount.
    void windowApi?.isFullscreen?.()
      .then((value) => {
        if (!disposed) setIsFullscreen(value);
      })
      .catch((error: unknown) => {
        console.warn('[Window] failed to read full-screen state:', error);
      });
    const unsubscribe = windowApi?.onStateChanged?.((state) => {
      setIsFullscreen(state.isFullscreen);
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return isFullscreen;
};
