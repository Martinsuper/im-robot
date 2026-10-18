import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { OnboardingStatus, PanelTab } from "../../types/appTypes";
import { OnboardingWindow } from "../onboarding/OnboardingWindow";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { PanelHeader, PanelNavigation } from "./PanelChrome";
import { useAppSettings } from "./settingsStore";
import { RecordsTab } from "./tabs/RecordsTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { TodayTab } from "./tabs/TodayTab";

const onboardingFallback: OnboardingStatus = { required: false, completed: true, version: "" };

/**
 * 主面板外壳（R1）。
 *
 * 职责被刻意压到最小：导航、主题、引导门禁、滚动复位。
 * 业务全部在三个 Tab 里，各自持有自己的数据与副作用——这样
 * 「今天 / 记录 / 设置」可以独立演进，也不会因为一个 Tab 的状态变化
 * 让另外两个跟着重渲染。
 */
export function PanelWindow() {
  const { settings } = useAppSettings();
  const [tab, setTab] = useState<PanelTab>("today");
  const [onboarding, setOnboarding] = useState<OnboardingStatus>(onboardingFallback);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // 只在渲染当前 Tab 之后复位滚动：换 Tab 时内容区仍是同一个滚动容器。
  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const refreshOnboarding = useCallback(async () => {
    const status = await runCommand<OnboardingStatus>(
      "get_onboarding_status",
      undefined,
      onboardingFallback,
    );
    setOnboarding(status ?? onboardingFallback);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refreshOnboarding);
    if (!isTauriRuntime) return;
    const pending = listen("onboarding-status-updated", () => void refreshOnboarding());
    return () => {
      void pending.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [refreshOnboarding]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const pending = listen<PanelTab>("panel-navigate", ({ payload }) => {
      if (["today", "records", "settings"].includes(payload)) setTab(payload);
    });
    return () => { void pending.then((unlisten) => unlisten()); };
  }, []);

  if (onboarding.required) {
    return (
      <OnboardingWindow
        onComplete={() => void refreshOnboarding()}
        onSkip={() => void refreshOnboarding()}
      />
    );
  }

  return (
    <main className={`panel-shell panel-shell--${settings.theme}`}>
      <PanelHeader tab={tab} companionName={settings.companionName} />
      <PanelNavigation tab={tab} onChange={setTab} />
      <div className="panel-workspace" ref={workspaceRef}>
        {tab === "today" ? <TodayTab /> : null}
        {tab === "records" ? <RecordsTab /> : null}
        {tab === "settings" ? <SettingsTab /> : null}
      </div>
    </main>
  );
}
