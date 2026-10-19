export type ModelConnectionStatus = {
  kind:
    | "idle"
    | "configured"
    | "dirty"
    | "savedKey"
    | "savedNoKey"
    | "savingFailed"
    | "connecting"
    | "connected"
    | "empty"
    | "failed";
  detail?: string;
};
type Translate = (key: string, fallback: string) => string;
export function connectionMessage(
  status: ModelConnectionStatus,
  t: Translate,
): string {
  switch (status.kind) {
    case "configured":
      return t("settings.connection.configured", "已配置密钥");
    case "dirty":
      return t("settings.connection.dirty", "有未保存的 AI 设置");
    case "savedKey":
      return t("settings.connection.savedKey", "已配置密钥，设置已保存");
    case "savedNoKey":
      return t("settings.connection.savedNoKey", "设置已保存，未配置密钥");
    case "savingFailed":
      return `${t("settings.connection.savingFailed", "保存失败")}：${status.detail ?? ""}`;
    case "connecting":
      return t("settings.connection.connecting", "正在连接...");
    case "connected":
      return `${t("settings.connection.connected", "已连接")}：${status.detail ?? ""}`;
    case "empty":
      return t("settings.connection.empty", "已连接，未发现模型");
    case "failed":
      return `${t("settings.connection.failed", "连接失败")}：${status.detail ?? ""}`;
    default:
      return t("settings.connection.idle", "尚未测试连接");
  }
}
