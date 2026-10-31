import type { Dispatch, SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Conversation } from "./agentTypes";
import { useStableEvent } from "../../hooks/useStableEvent";
import { useToast } from "../../components/feedback/toastStore";
import { runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";

export function useWorkspaceSelection(
  requestId: string | undefined,
  required: boolean,
  setConversation: Dispatch<SetStateAction<Conversation>>,
) {
  const toast = useToast();
  const chooseWorkspace = useStableEvent(async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "选择工作目录",
      });
      if (typeof path !== "string") return;
      if (required && requestId)
        await runCommand("agent_select_workspace", { requestId, path });
      // 手选目录脱离项目绑定；项目切换走 ChatContextMenu 的项目列表。
      setConversation((current) => ({ ...current, cwd: path, projectId: undefined, projectName: undefined }));
    } catch (error) {
      toast.error(toUserMessage(error, "选择目录失败"));
    }
  });
  const cancelWorkspace = useStableEvent(async () => {
    if (!requestId) return;
    try {
      await runCommand("agent_select_workspace", { requestId, path: null });
    } catch (error) {
      toast.error(toUserMessage(error, "取消失败"));
    }
  });
  return { chooseWorkspace, cancelWorkspace };
}
