import { ArrowUpRight, Bell, BookOpen, CalendarDays, History, Info, MessageCircle, PawPrint, Settings2, StickyNote } from "lucide-react";
import type { PanelTab } from "../../types/appTypes";
import { panelTabOptions, PetSprite } from "../app/appShared";
import { runCommand } from "../app/appRuntime";

const icons = { companion: PawPrint, settings: Settings2, reminders: Bell, calendar: CalendarDays, memos: StickyNote, history: History, memory: BookOpen, about: Info };
const titles: Record<PanelTab, [string, string]> = {
  companion: ["有 Piko 陪着的一天", "聊聊想法，把日常慢慢安排好。"],
  settings: ["按你的习惯来", "让这个小伙伴，更懂你的节奏。"],
  reminders: ["把重要的事记住", "安心专注，到时间我会提醒你。"],
  calendar: ["为今天留一点从容", "安排日程，也给休息留个位置。"],
  memos: ["灵感，先留在这里", "记下想法，之后再慢慢整理。"],
  history: ["我们聊过的那些事", "找回有用的回答，接着上次的想法。"],
  memory: ["一点点，认识你", "查看和管理 Piko 记住的事情。"],
  about: ["关于这个小伙伴", "权限、插件与版本，都在这里。"],
};

export function PanelHeader({ tab, companionName }: { tab: PanelTab; companionName: string }) {
  return <header className="panel-header">
    <div className="panel-brand"><span className="panel-brand__mark"><PawPrint size={17} /></span><strong>{companionName}</strong><span>桌面陪伴助手</span></div>
    <div className="panel-heading"><div><h1>{titles[tab][0]}</h1><p>{titles[tab][1]}</p></div><span className="status-pill">陪伴中</span></div>
  </header>;
}

export function PanelNavigation({ tab, onChange }: { tab: PanelTab; onChange: (tab: PanelTab) => void }) {
  return <nav className="panel-tabs" aria-label="面板导航">
    {panelTabOptions.map(({ value, label }) => {
      const Icon = icons[value];
      return <button type="button" key={value} className={tab === value ? "is-active" : ""} aria-current={tab === value ? "page" : undefined} onClick={() => onChange(value)}><Icon size={17} strokeWidth={1.7} /><span>{label}</span></button>;
    })}
  </nav>;
}

export function CompanionHero({ companionName, styleLabel, modelLabel, onReminders }: { companionName: string; styleLabel: string; modelLabel: string | null; onReminders: () => void }) {
  return <section className="companion-card companion-hero" aria-label="我的伙伴">
    <div className="companion-card__copy"><p className="eyebrow">YOUR EVERYDAY COMPANION</p><h2>我在，随时都在。</h2><p>我是 {companionName}。陪你聊一聊，<br />也帮你照顾好今天的小事。</p><div className="companion-hero__actions"><button type="button" className="primary-action" onClick={() => void runCommand("show_bubble")}><MessageCircle size={16} />开始对话<ArrowUpRight size={15} /></button><button type="button" className="text-action" onClick={onReminders}>安排今天</button></div></div>
    <div className="companion-card__portrait"><PetSprite mode="idle" /><span>{styleLabel}{modelLabel ? ` · ${modelLabel}` : ""}</span></div>
  </section>;
}
