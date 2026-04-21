import React from "react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * App-level ErrorBoundary. Wraps the routes so a runtime crash in any
 * page shows a recoverable fallback instead of a blank white screen.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
          <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center space-y-4">
            <div className="text-6xl">😕</div>
            <h1 className="text-2xl font-bold text-gray-900">Нещо се обърка</h1>
            <p className="text-gray-600">
              Възникна неочаквана грешка. Можете да опитате да презаредите
              страницата или да се върнете.
            </p>
            <div className="flex gap-2 justify-center pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
              >
                Опитай отново
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="px-4 py-2 rounded-md bg-[#f97316] text-white hover:bg-[#ea580c] text-sm font-medium"
              >
                Презареди страницата
              </button>
            </div>
            {this.state.error && (
              <details className="text-xs text-gray-500 text-left mt-4 pt-4 border-t">
                <summary className="cursor-pointer hover:text-gray-700">
                  Технически детайли
                </summary>
                <pre className="mt-2 whitespace-pre-wrap break-words font-mono">
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
