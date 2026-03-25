import React from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../services/i18n';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[ErrorBoundary] uncaught render error:', error, errorInfo.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg p-6">
        <div className="flex flex-col items-center space-y-6 max-w-md">
          <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
            <ExclamationTriangleIcon className="h-8 w-8 text-white" />
          </div>
          <div className="dark:text-claude-darkText text-claude-text text-xl font-medium text-center">
            {i18nService.t('errorBoundaryTitle')}
          </div>
          <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm text-center">
            {this.state.error?.message}
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={this.handleReset}
              className="px-6 py-2.5 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl shadow-md transition-colors text-sm font-medium"
            >
              {i18nService.t('errorBoundaryRetry')}
            </button>
            <button
              onClick={this.handleReload}
              className="px-6 py-2.5 dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:opacity-80 rounded-xl shadow-md transition-colors text-sm font-medium"
            >
              {i18nService.t('errorBoundaryReload')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
