/**
 * 把任意异常归一化成用户能看懂的中文文案。
 *
 * 设计原则（对齐 00 §5.7「确定性文案原则」）：
 * - 绝不把原始错误堆栈、`Error:` 前缀、`[object Object]`、`undefined` 直出给用户。
 * - 能识别的常见失败给出可行动的提示；识别不了就退回到调用方给的安全兜底文案。
 */

/** 技术前缀，去掉后再判断。 */
const TECHNICAL_PREFIXES: RegExp[] = [
  /^error:\s*/i,
  /^uncaught\s+(in promise\s+)?/i,
  /^typeerror:\s*/i,
  /^invoke error:\s*/i,
  /^ipc error:\s*/i,
];

/**
 * IPC 机器码 → 用户文案。与 Rust 侧 `src-tauri/src/error_codes.rs` 注册表一一对应。
 * 机器码是稳定契约，精确匹配优先于下面的正则降级；只收「语境无关」的码——
 * 语境化的码（soul / candidate / desktop 等）继续走调用点的本地化 fallback。
 */
const CODE_MESSAGES: Record<string, string> = {
  // 数据层可用性
  storage_unavailable: "本地数据暂时不可用，请稍后重试。",
  storage_write_failed: "本地数据保存失败，请稍后重试。",
  ledger_unreadable: "本地数据暂时无法读取，请重启应用后重试。",
  ledger_write_failed: "本地数据保存失败，请稍后重试。",
  quota_unreadable: "本地数据暂时无法读取，请重启应用后重试。",
  state_unavailable: "本地数据暂时不可用，请稍后重试。",
  mood_unreadable: "本地数据暂时无法读取，请重启应用后重试。",
  mood_write_failed: "本地数据保存失败，请稍后重试。",
  data_gate_unavailable: "本地数据正在备份或恢复，请稍后重试。",
  // 并发冲突
  revision_conflict: "内容已在其他窗口被修改，请刷新后重试。",
  loop_revision_conflict: "内容已在其他窗口被修改，请刷新后重试。",
  settings_conflict: "设置已在其他窗口被修改，请刷新后重试。",
  // 能力与窗口
  capability_unavailable: "当前环境不支持该功能。",
  window_unavailable: "目标窗口已关闭。",
  permission_unavailable: "缺少必要的系统权限，请在「设置 → 系统与隐私」中授权。",
  permission_request_pending: "正在等待系统授权，请在系统弹窗中确认。",
  // 后台任务
  background_task_failed: "后台任务异常终止，请重试。",
  worker_panicked: "后台任务异常终止，请重试。",
  data_worker_panicked: "后台任务异常终止，请重试。",
  // 插件
  wasm_module_path_invalid: "插件文件无效，无法加载。",
  wasm_module_outside_plugin: "插件文件无效，无法加载。",
  wasm_module_too_large: "插件文件过大，无法加载。",
  wasm_input_too_large: "插件输入过大，无法执行。",
  wasm_runtime_stopped: "插件服务已停止，请重启应用后重试。",
  wasm_execution_timeout: "插件执行超时，请重试。",
  // 宠物状态持久化
  pet_state_key_invalid: "宠物状态保存失败，请重试。",
  pet_state_too_large: "宠物状态保存失败，请重试。",
  pet_state_invalid_json: "宠物状态保存失败，请重试。",
  pet_state_invalid_shape: "宠物状态保存失败，请重试。",
  pet_state_revision_overflow: "宠物状态保存失败，请重试。",
};

/** 常见失败 → 可行动的中文提示。顺序敏感：先具体后笼统。 */
const KNOWN_FAILURES: Array<{ test: RegExp; message: string }> = [
  { test: /state not managed|state.*not.*managed|must call.*manage\(\)/i, message: "应用内部服务未正确初始化，请更新应用或重启后重试。" },
  { test: /api\s?key|unauthorized|401|invalid_api_key/i, message: "API Key 无效或已过期，请在「设置 → 对话与模型」中重新填写。" },
  { test: /insufficient|quota|balance|余额|额度/i, message: "账户额度不足，请检查服务商余额。" },
  { test: /429|rate.?limit|too many requests|频繁/i, message: "请求过于频繁，请稍后再试。" },
  { test: /api\.anthropic|api\.openai|provider|上游/i, message: "模型服务返回异常，请稍后重试或更换服务。" },
  { test: /failed to fetch|networkerror|network request failed|dns|econnrefused|econnreset|网络/i, message: "网络连接失败，请检查网络后重试。" },
  { test: /timeout|timed out|etimedout|超时/i, message: "请求超时，请稍后重试。" },
  { test: /permission|denied|not permitted|未授权|权限/i, message: "缺少必要的系统权限，请在「设置 → 系统与隐私」中授权。" },
  { test: /database is locked|sqlite|locked|database/i, message: "本地数据暂时被占用，请稍后重试。" },
  { test: /already exists|已存在/i, message: "目标已存在。" },
  { test: /no such file|not found|not_found|找不到/i, message: "找不到目标内容，可能已被删除。" },
  { test: /json|parse|serde|deserialize|序列化/i, message: "数据格式异常，操作未完成。" },
  { test: /cancelled|canceled|aborted|已取消/i, message: "操作已取消。" },
];

/** 明显不是人话的返回值，遇到就退回兜底文案。 */
const NON_HUMAN_RESULTS = new Set([
  "",
  "undefined",
  "null",
  "nan",
  "[object object]",
  "[object object] ",
  "{}",
  "[]",
]);

const MAX_MESSAGE_LENGTH = 160;

function extractRaw(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name || "";
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  if (typeof error === "object") {
    // Tauri 的错误有时是 { message } / { error } 包一层，先尝试取出来。
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    try {
      const serialized = JSON.stringify(error);
      return typeof serialized === "string" ? serialized : "";
    } catch {
      return "";
    }
  }
  return "";
}

function stripNoise(raw: string): string {
  // 只保留第一行：堆栈、Rust 的 `Caused by:` 链、多行 panic 都从这里截断。
  let text = raw.split(/\r?\n/).find((line) => line.trim()) ?? raw;
  text = text.trim();
  for (const prefix of TECHNICAL_PREFIXES) {
    text = text.replace(prefix, "");
  }
  // 去掉 Rust 侧的 "StringError(\"...\")" 之类包装。
  const wrapped = text.match(/^(?:\w+Error)\((["'])([\s\S]*)\1\)$/);
  if (wrapped) text = wrapped[2];
  return text.trim();
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * @param error 捕获到的任意异常
 * @param fallback 无法识别时使用的兜底文案（必须是人话）
 */
export function toUserMessage(error: unknown, fallback = "操作失败，请重试。"): string {
  const cleaned = stripNoise(extractRaw(error));
  if (NON_HUMAN_RESULTS.has(cleaned.toLowerCase())) return fallback;

  // 机器码精确匹配优先（IpcFailure 的 message 就是码本身）。
  const codeMessage = CODE_MESSAGES[cleaned];
  if (codeMessage) return codeMessage;

  for (const { test, message } of KNOWN_FAILURES) {
    if (test.test(cleaned)) return message;
  }

  // 剩余情况：中文原文通常已经是后端写好的用户文案，可以直接用；
  // 纯英文技术串则不可直出，退回兜底。
  const hasChinese = /[\u4e00-\u9fff]/.test(cleaned);
  if (!hasChinese) return fallback;

  return truncate(cleaned);
}
