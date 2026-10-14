import { ArrowUpRight, CalendarCheck, CalendarDays, MessageCircle, NotebookPen, PawPrint, Settings2 } from "lucide-react";
import type { PanelTab } from "../../types/appTypes";
import { panelTabOptions, PetSprite } from "../app/appShared";
import { runCommand } from "../app/appRuntime";
import "./settingsGroup.css";

const icons = { today: CalendarCheck, records: NotebookPen, settings: Settings2 };

const titles: Record<PanelTab, [string, string]> = {
  today: ["今天要做什么", "一条时间线，一个计时器，就够了。"],
  records: ["写下的，和记住的", "你写的和 Piko 记住的，都在这里，都能搜到。"],
  settings: ["设置", ""],
};

export function PanelHeader({ tab, companionName }: { tab: PanelTab; companionName: string }) {
  return (
    <header className="panel-header">
      <div className="panel-brand">
        <span className="panel-brand__mark"><PawPrint size={17} /></span>
        <strong>{companionName}</strong>
        <span>桌面陪伴助手</span>
      </div>
      <div className="panel-heading">
        <div>
          <h1>{titles[tab][0]}</h1>
          {titles[tab][1] ? <p>{titles[tab][1]}</p> : null}
        </div>
        <button type="button" className="status-pill status-pill--action" onClick={() => void runCommand("show_bubble")}>
          <MessageCircle size={14} />对话
        </button>
      </div>
    </header>
  );
}

export function PanelNavigation({ tab, onChange }: { tab: PanelTab; onChange: (tab: PanelTab) => void }) {
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

/** 伙伴名片。现在住在「设置 → 伙伴」里，同时充当外观风格的预览。 */
export function CompanionHero({ companionName, styleLabel, onAppearance }: { companionName: string; styleLabel: string; onAppearance: () => void }) {
  return (
    <section className="companion-card companion-hero" aria-label="我的伙伴">
      <div className="companion-card__copy">
        <p className="eyebrow">YOUR EVERYDAY COMPANION</p>
        <h2>我在，随时都在。</h2>
        <p>我是 {companionName}。陪你聊一聊，<br />也帮你照顾好今天的小事。</p>
        <div className="companion-hero__actions">
          <button type="button" className="primary-action" onClick={() => void runCommand("show_bubble")}>
            <MessageCircle size={16} />开始对话<ArrowUpRight size={15} />
          </button>
          <button type="button" className="text-action" onClick={onAppearance}>换个样子</button>
        </div>
      </div>
      <div className="companion-card__portrait">
        <PetSprite mode="idle" />
        <span>{styleLabel}</span>
      </div>
    </section>
  );
}

/** 折叠分组的统一外壳，供「设置」的 5 组 + 高级使用。 */
export function SettingsGroup({
  id,
  icon,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="settings-group" id={`settings-group-${id}`} open={defaultOpen}>
      <summary>
        <span className="settings-group__icon" aria-hidden="true">{icon}</span>
        <span className="settings-group__title">{title}</span>
        {description ? <span className="settings-group__description">{description}</span> : null}
      </summary>
      <div className="settings-group__body">{children}</div>
    </details>
  );
}

/** 「今天」用的空状态图标，避免每个 Tab 各自引一套。 */
export const TodayEmptyIcon = CalendarDays;
