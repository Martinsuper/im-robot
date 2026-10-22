import { useCallback, useEffect, useState } from "react";
import { PanelRightClose } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
 * 导航、主题和引导门禁；访问过的栏目保持挂载，保留草稿与滚动位置。
 * 业务全部在三个 Tab 里，各自持有自己的数据与副作用——这样
 * 「今天 / 记录 / 设置」可以独立演进，也不会因为一个 Tab 的状态变化
 * 让另外两个跟着重渲染。
 */
export function PanelWindow({ activeTab, onTabChange, onClose }: {
  activeTab?: PanelTab;
  onTabChange?: (tab: PanelTab) => void;
  onClose?: () => void;
} = {}) {
  const { settings } = useAppSettings();
  const [localTab, setLocalTab] = useState<PanelTab>("today");
  const tab = activeTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const [visited, setVisited] = useState<Set<PanelTab>>(() => new Set([tab]));
  const [onboarding, setOnboarding] = useState<OnboardingStatus>(onboardingFallback);
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));

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
  }, [setTab]);

  if (onboarding.required) {
    return (
      <OnboardingWindow
        onComplete={() => void refreshOnboarding()}
        onSkip={() => void refreshOnboarding()}
      />
    );
  }

  return (
    <section className={`panel-shell panel-shell--${settings.theme}${onClose ? " panel-shell--embedded" : ""}`} aria-label="主面板工作区">
      {onClose ? <header className="workspace-header" onPointerDown={(event) => {
        if (isTauriRuntime && event.button === 0 && !(event.target as HTMLElement).closest("button")) void getCurrentWindow().startDragging();
      }}><strong>工作区</strong><button type="button" onClick={onClose} aria-label="收起工作区" title="收起工作区，继续聊天"><PanelRightClose size={16} /><span>返回聊天</span></button></header> : <PanelHeader tab={tab} companionName={settings.companionName} />}
      <PanelNavigation tab={tab} onChange={setTab} />
      {(["today", "records", "settings"] as const).map((value) => <div key={value} className="panel-workspace" hidden={tab !== value}>
        {(visited.has(value) || tab === value) && (value === "today" ? <TodayTab /> : value === "records" ? <RecordsTab /> : <SettingsTab />)}
      </div>)}
    </section>
  );
}
