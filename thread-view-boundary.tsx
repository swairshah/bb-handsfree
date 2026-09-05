import React, { Component, type ReactNode } from "react";

export class ViewErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert" className="p-4 text-sm text-destructive">This thread could not be displayed. Close it and try opening it again.</p>
      : this.props.children;
  }
}

