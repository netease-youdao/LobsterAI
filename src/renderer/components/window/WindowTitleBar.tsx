import React, { useEffect, useState } from 'react';

interface WindowTitleBarProps {
  isOverlayActive?: boolean;
  inline?: boolean;
  className?: string;
}

type WindowState = {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
};

const DEFAULT_STATE: WindowState = {
  isMaximized: false,
  isFullscreen: false,
  isFocused: true,
};

const WindowControlAction = {
  Minimize: 'minimize',
  Maximize: 'maximize',
  Restore: 'restore',
  Close: 'close',
} as const;
type WindowControlAction = typeof WindowControlAction[keyof typeof WindowControlAction];

// The caption buttons sit on the white canvas side of the title bar, so the
// hover wash is a translucent tint rather than the (white) surface color.
const WINDOW_CAPTION_BUTTON_CLASS_NAME = 'non-draggable inline-flex h-full w-[46px] shrink-0 items-center justify-center text-foreground/90 outline-none transition-colors duration-100 hover:bg-black/[0.05] focus-visible:bg-black/[0.05] active:bg-black/[0.08] dark:hover:bg-white/[0.08] dark:focus-visible:bg-white/[0.08] dark:active:bg-white/[0.12]';
const WINDOW_CLOSE_CAPTION_BUTTON_CLASS_NAME = 'non-draggable inline-flex h-full w-[46px] shrink-0 items-center justify-center text-foreground/90 outline-none transition-colors duration-100 hover:bg-[#c42b1c] hover:text-white focus-visible:bg-[#c42b1c] focus-visible:text-white active:bg-[#b1261a] active:text-white';

const reportWindowControlAction = (action: WindowControlAction): void => {
  const message = `window control requested action=${action}`;
  console.debug(`[WindowTitleBar] ${message}`);
  try {
    window.electron?.log?.fromRenderer?.('debug', 'WindowTitleBar', message);
  } catch {
    // Window controls must remain available even if diagnostic logging fails.
  }
};

const WindowTitleBar: React.FC<WindowTitleBarProps> = ({
  isOverlayActive = false,
  inline = false,
  className = '',
}) => {
  const [state, setState] = useState<WindowState>(DEFAULT_STATE);

  useEffect(() => {
    if (window.electron.platform !== 'win32') return;

    let disposed = false;
    window.electron.window.isMaximized().then((isMaximized) => {
      if (!disposed) {
        setState((prev) => ({ ...prev, isMaximized }));
      }
    }).catch((error) => {
      console.error('Failed to get initial maximize state:', error);
    });

    const unsubscribe = window.electron.window.onStateChanged((nextState) => {
      setState(nextState);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const handleMinimize = () => {
    reportWindowControlAction(WindowControlAction.Minimize);
    window.electron.window.minimize();
  };

  const handleToggleMaximize = () => {
    reportWindowControlAction(
      state.isMaximized ? WindowControlAction.Restore : WindowControlAction.Maximize,
    );
    window.electron.window.toggleMaximize();
  };

  const handleClose = () => {
    reportWindowControlAction(WindowControlAction.Close);
    window.electron.window.close();
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    window.electron.window.showSystemMenu({
      x: event.clientX,
      y: event.clientY,
    });
  };

  const handleDoubleClick = () => {
    if (!state.isFullscreen) {
      handleToggleMaximize();
    }
  };

  if (window.electron.platform !== 'win32') {
    return null;
  }

  const containerClassName = inline
    ? `window-controls-floating non-draggable flex h-full items-stretch transition-opacity ${!state.isFocused ? 'opacity-70' : 'opacity-100'} ${className}`.trim()
    : `window-controls-floating non-draggable absolute top-0 right-0 z-[55] flex h-9 items-stretch transition-opacity ${
      !state.isFocused ? 'opacity-70' : 'opacity-100'
    } ${
      isOverlayActive
        ? 'bg-transparent'
        : 'bg-surface/35 backdrop-blur-sm'
    } ${className}`.trim();

  return (
    <div
      className={containerClassName}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={handleMinimize}
        className={WINDOW_CAPTION_BUTTON_CLASS_NAME}
        aria-label="Minimize"
        title="Minimize"
      >
        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
          <path d="M2 6.5h8" />
        </svg>
      </button>
      <button
        type="button"
        onClick={handleToggleMaximize}
        className={WINDOW_CAPTION_BUTTON_CLASS_NAME}
        aria-label={state.isMaximized ? 'Restore' : 'Maximize'}
        title={state.isMaximized ? 'Restore' : 'Maximize'}
      >
        {state.isMaximized ? (
          <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="round">
            <path d="M4 1.5h6.5V8H8" />
            <rect x="1.5" y="4" width="6.5" height="6.5" rx="0.6" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="2" y="2" width="8" height="8" rx="0.7" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={handleClose}
        className={WINDOW_CLOSE_CAPTION_BUTTON_CLASS_NAME}
        aria-label="Close"
        title="Close"
      >
        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
          <path d="M2 2l8 8" />
          <path d="M10 2L2 10" />
        </svg>
      </button>
    </div>
  );
};

export default WindowTitleBar;
