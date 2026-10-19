import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "../../features/i18n/I18nProvider";

type Labels = {
  title: string;
  description: string;
  retry: string;
  reload: string;
  copy: string;
  copied: string;
  copyFailed: string;
};
class Boundary extends Component<
  { children: ReactNode; labels: Labels },
  { error?: Error; copyStatus?: string; generation: number }
> {
  state: { error?: Error; copyStatus?: string; generation: number } = {
    generation: 0,
  };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[window] render failed", error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    const { labels } = this.props;
    if (!error)
      return (
        <div key={this.state.generation} style={{ display: "contents" }}>
          {this.props.children}
        </div>
      );
    return (
      <main className="app-error" role="alert">
        <h1>{labels.title}</h1>
        <p>{labels.description}</p>
        <button
          type="button"
          onClick={() =>
            this.setState((s) => ({
              error: undefined,
              copyStatus: undefined,
              generation: s.generation + 1,
            }))
          }
        >
          {labels.retry}
        </button>
        <button type="button" onClick={() => window.location.reload()}>
          {labels.reload}
        </button>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(
                  `${error.name}: ${error.message}`,
                );
                this.setState({ copyStatus: labels.copied });
              } catch {
                this.setState({ copyStatus: labels.copyFailed });
              }
            })();
          }}
        >
          {labels.copy}
        </button>
        {this.state.copyStatus && <p role="status">{this.state.copyStatus}</p>}
      </main>
    );
  }
}
export function WindowErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Boundary
      labels={{
        title: t("app.error.title", "页面暂时无法显示"),
        description: t(
          "app.error.description",
          "请重试或重新加载。仍有问题时，可复制诊断信息。",
        ),
        retry: t("app.error.retry", "重试"),
        reload: t("app.error.reload", "重新加载"),
        copy: t("app.error.copy", "复制诊断信息"),
        copied: t("app.error.copied", "诊断信息已复制"),
        copyFailed: t("app.error.copyFailed", "无法复制诊断信息，请重试。"),
      }}
    >
      {children}
    </Boundary>
  );
}
