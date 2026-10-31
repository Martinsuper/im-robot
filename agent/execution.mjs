// Text asking for approval is not an approval request. Only a tool invocation
// can enter the application's permission gate.
export function isTextOnlyApproval(text) {
  return /(?:请|等待|需要|待你|待您)[^\n。！？]{0,45}(?:批准|授权|确认执行|允许执行)|(?:please|waiting for|awaiting|need your)[^\n.!?]{0,60}(?:approv|authoriz|confirm)/i.test(text);
}

// 伴侣对话的纠正提示：带聊天业务工具规则（现状保持不变）。
const COMPANION_CORRECTION = "你刚才只用文字请求批准，没有调用工具，任务尚未执行。继续完成用户原始任务。日程、提醒、备忘录和专注必须调用对应应用业务工具，不要为这些任务选择目录或使用文件/命令工具。只有用户要求处理文件或命令时才使用系统工具。需要命令时立即调用 bash/PowerShell 工具，需要读取文件时调用 read；不要把命令代码块或‘请批准’当作工具调用。应用会在工具执行前暂停并展示真正的确认卡片，只有用户点击卡片才表示批准。此消息不代表用户批准了任何操作。若信息不足则明确追问，不要声称完成。";

// 委托任务（coding）的纠正提示：无聊天业务工具规则，只有系统工具纪律（PRD 04 §4.5）。
const CODING_CORRECTION = "你刚才只用文字请求批准，没有调用工具，任务尚未执行。继续完成当前里程碑。需要命令时立即调用 bash/PowerShell 工具，需要读取或修改文件时调用 read/write/edit；不要把命令代码块或‘请批准’当作工具调用。应用会在工具执行前按任务策略展示确认卡片，只有用户确认才表示批准。此消息不代表用户批准了任何操作。若信息不足，把疑问写入任务日志并继续可执行的部分，不要声称完成。";

export async function executePrompt(session, prompt, { toolCount, cancelled, emit, images, taskKind } = {}) {
  await session.prompt(prompt, images?.length ? { images } : undefined);
  const assistant = () => [...session.messages].reverse().find((message) => message.role === "assistant");
  const text = () => (assistant()?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  if (!cancelled() && isTextOnlyApproval(text())) {
    const retryCount = toolCount();
    emit({ type: "delta", text: "\n\n正在发起实际工具调用，操作确认将由应用显示。\n" });
    await session.prompt(taskKind === "coding" ? CODING_CORRECTION : COMPANION_CORRECTION);
    if (!cancelled() && (toolCount() === retryCount || isTextOnlyApproval(text())) && !["error", "aborted"].includes(assistant()?.stopReason)) {
      throw new Error("模型只输出了批准说明，没有发起工具调用，任务尚未执行。请重试或换用支持工具调用的模型。");
    }
  }
}
