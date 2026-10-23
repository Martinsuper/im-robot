import { DataRestoreStatus } from "./components/feedback/DataRestoreStatus";
import { PersistenceStatus } from "./components/feedback/PersistenceStatus";
import { WindowErrorBoundary } from "./components/feedback/WindowErrorBoundary";
import { lazy, Suspense } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ToastProvider } from "./components/feedback/Toast";
import { I18nProvider } from "./features/i18n/I18nProvider";
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";
import "./features/app/design-system.css";
import "./features/chat/bubble.css";
import "./styles/modern.css";

type WindowLabel = "pet" | "bubble" | "panel" | "capture" | "html-preview";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
const BubbleWindow = lazy(() => import("./features/chat/ConversationTabs").then((module) => ({ default: module.ConversationTabs })));
const CaptureWindow = lazy(() => import("./features/capture/CaptureWindow").then((module) => ({ default: module.CaptureWindow })));
const PetWindow = lazy(() => import("./features/pet/PetWindow").then((module) => ({ default: module.PetWindow })));

const HtmlPreviewWindow = lazy(() => import("./features/chat/HtmlPreviewFrame").then((module) => ({ default: module.HtmlPreviewWindow })));

function detectWindowLabel(): WindowLabel {
  const preview = new URLSearchParams(window.location.search).get("view");
  if (preview === "html-preview") return "html-preview";
  if (preview === "bubble" || preview === "panel" || preview === "capture" || preview === "pet") return preview;

  if (isTauriRuntime) {
    const label = getCurrentWindow().label;
    if (label === "bubble" || label === "panel" || label === "capture") return label;
    return "pet";
  }

  return preview === "bubble" || preview === "panel" || preview === "capture" ? preview : "pet";
}

const windowLabel = detectWindowLabel();

function App() {
  return (
    // Boundary catches render and lazy-import failures inside each window.
    <ToastProvider>
      <I18nProvider>
        <WindowErrorBoundary>
        <PersistenceStatus />
        <DataRestoreStatus />
        <Suspense fallback={<main className="app-loading">加载中…</main>}>
          {windowLabel === "html-preview" ? <HtmlPreviewWindow /> : null}
          {windowLabel === "bubble" ? <BubbleWindow /> : null}
          {windowLabel === "panel" ? <BubbleWindow initialWorkspaceOpen /> : null}
          {windowLabel === "capture" ? <CaptureWindow /> : null}
          {windowLabel === "pet" ? <PetWindow /> : null}
        </Suspense>
        </WindowErrorBoundary>
      </I18nProvider>
    </ToastProvider>
  );
}

export default App;
