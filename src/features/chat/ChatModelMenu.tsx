import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ModelSettingsDialog } from "../panel/ModelSettingsDialog";
import { useAppSettings } from "../panel/settingsStore";
import "./chatModelMenu.css";

export function ChatModelMenu({ disabled }: { disabled: boolean }) {
  const { settings } = useAppSettings();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="chat-model-trigger" data-no-drag disabled={disabled}
      aria-haspopup="dialog" aria-expanded={open} aria-label={`选择模型：${settings.ai.model || "未选择模型"}`}
      title={disabled ? "当前回复结束后可切换模型" : "模型与 API"} onClick={() => setOpen(true)}>
      <span>{settings.ai.model || "选择模型"}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <ModelSettingsDialog onClose={() => setOpen(false)} />}
  </>;
}
