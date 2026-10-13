import { lazy, Suspense } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ToastProvider } from "./components/feedback/Toast";
import { I18nProvider } from "./features/i18n/I18nProvider";
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";
import "./features/app/design-system.css";

type WindowLabel = "pet" | "bubble" | "panel" | "capture";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
const BubbleWindow = lazy(() => import("./features/chat/BubbleWindow").then((module) => ({ default: module.BubbleWindow })));
const CaptureWindow = lazy(() => import("./features/capture/CaptureWindow").then((module) => ({ default: module.CaptureWindow })));
const PanelWindow = lazy(() => import("./features/panel/PanelWindow").then((module) => ({ default: module.PanelWindow })));
const PetWindow = lazy(() => import("./features/pet/PetWindow").then((module) => ({ default: module.PetWindow })));

function detectWindowLabel(): WindowLabel {
  const preview = new URLSearchParams(window.location.search).get("view");
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
    // ToastProvider 放在 Suspense 外层：懒加载失败时也能把错误报出来。
    <ToastProvider>
      <I18nProvider>
        <Suspense fallback={<main className="app-loading">加载中…</main>}>
          {windowLabel === "bubble" ? <BubbleWindow /> : null}
          {windowLabel === "panel" ? <PanelWindow /> : null}
          {windowLabel === "capture" ? <CaptureWindow /> : null}
          {windowLabel === "pet" ? <PetWindow /> : null}
        </Suspense>
      </I18nProvider>
    </ToastProvider>
  );
}

export default App;
