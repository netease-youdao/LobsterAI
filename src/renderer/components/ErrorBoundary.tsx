import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[ErrorBoundary] uncaught render error:', error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg gap-4">
          <div className="text-4xl">⚠️</div>
          <div className="dark:text-claude-darkText text-claude-text text-xl font-medium">
            页面发生错误
          </div>
          <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm text-center max-w-sm px-4">
            应用渲染时遇到了意外错误
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-claude-accent text-white rounded-lg text-sm hover:opacity-90 transition-opacity"
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
