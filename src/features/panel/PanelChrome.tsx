import {
  CalendarCheck,
  MessageCircle,
  NotebookPen,
  PawPrint,
  Settings2,
} from "lucide-react";
import type { PanelTab } from "../../types/appTypes";
import { panelTabOptions } from "../app/appShared";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import "./settingsGroup.css";

const icons = {
  today: CalendarCheck,
  records: NotebookPen,
  settings: Settings2,
};

const titles: Record<PanelTab, [string, string]> = {
  today: ["今天", ""],
  records: ["记录", ""],
  settings: ["设置", ""],
};

export function PanelHeader({
  tab,
  companionName,
}: {
  tab: PanelTab;
  companionName: string;
}) {
  return (
    <header className="panel-header panel-header--compact">
      <div className="panel-brand">
        <span className="panel-brand__mark">
          <PawPrint size={17} />
        </span>
        <strong>{companionName}</strong>
      </div>
      <h1 className="sr-only">{titles[tab][0]}</h1>
      <button
        type="button"
        className="status-pill status-pill--action"
        onClick={() => {
          if (isTauriRuntime) void runCommand("show_bubble");
          else window.location.assign("/?view=bubble");
        }}
      >
        <MessageCircle size={14} />
        开始对话
      </button>
    </header>
  );
}

export function PanelNavigation({
  tab,
  onChange,
}: {
  tab: PanelTab;
  onChange: (tab: PanelTab) => void;
}) {
  return (
    <nav className="panel-tabs" aria-label="面板导航">
      {panelTabOptions.map(({ value, label }) => {
        const Icon = icons[value];
        return (
          <button
            type="button"
            key={value}
            className={tab === value ? "is-active" : ""}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => onChange(value)}
          >
            <Icon size={17} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** 折叠分组的统一外壳，供「设置」的四个分组使用。 */
export function SettingsGroup({
  id,
  icon,
  title,
  description,
  status,
  defaultOpen = false,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description?: string;
  status?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className="settings-group"
      id={`settings-group-${id}`}
      open={defaultOpen}
    >
      <summary>
        <span className="settings-group__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="settings-group__title">{title}</span>
        {status || description ? (
          <span
            className={`settings-group__description${status ? " settings-group__status" : ""}`}
            title={status || description}
          >
            {status || description}
          </span>
        ) : null}
      </summary>
      <div className="settings-group__body">{children}</div>
    </details>
  );
}
