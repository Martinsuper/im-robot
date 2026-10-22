import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { PanelTab } from "../../types/appTypes";

/** Explicit, keyboard-accessible navigation without making the drag region clickable. */
export function WorkspaceMenu({ children, onSelect }: { children: ReactNode; onSelect: (tab: PanelTab) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div className="workspace-menu" ref={root} data-no-drag onKeyDown={(event) => {
    if (event.key === "Tab") setOpen(false);
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }
    if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(root.current!.querySelectorAll<HTMLButtonElement>("[role=menuitem]"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="workspace-menu__trigger" aria-label="主面板菜单" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{children}<ChevronDown size={14} /></button>
    {open && <div className="workspace-menu__popup" role="menu" aria-label="工作区">
      <span className="workspace-menu__label">工作区</span>
      {([["today", "今天"], ["records", "记录"], ["settings", "设置"]] as const).map(([tab, label]) => <button key={tab} type="button" role="menuitem" onClick={() => { setOpen(false); trigger.current?.focus(); onSelect(tab); }}>{label}</button>)}
    </div>}
  </div>;
}
