import { lazy, Suspense } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type WindowLabel = "pet" | "bubble" | "panel" | "capture";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
const BubbleWindow = lazy(() => import("./features/chat/BubbleWindow").then((module) => ({ default: module.BubbleWindow })));
const CaptureWindow = lazy(() => import("./features/capture/CaptureWindow").then((module) => ({ default: module.CaptureWindow })));
const PanelWindow = lazy(() => import("./features/panel/PanelWindow").then((module) => ({ default: module.PanelWindow })));
const PetWindow = lazy(() => import("./features/pet/PetWindow").then((module) => ({ default: module.PetWindow })));

function detectWindowLabel(): WindowLabel {
  if (isTauriRuntime) return getCurrentWindow().label as WindowLabel;

  const preview = new URLSearchParams(window.location.search).get("view");
  return preview === "bubble" || preview === "panel" || preview === "capture" ? preview : "pet";
}

const windowLabel = detectWindowLabel();

function App() {
  return (
    <Suspense fallback={<main className="app-loading">加载中…</main>}>
      {windowLabel === "bubble" ? <BubbleWindow /> : null}
      {windowLabel === "panel" ? <PanelWindow /> : null}
      {windowLabel === "capture" ? <CaptureWindow /> : null}
      {windowLabel === "pet" ? <PetWindow /> : null}
    </Suspense>
  );
}

export default App;
