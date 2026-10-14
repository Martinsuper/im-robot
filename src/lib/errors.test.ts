import { describe, expect, it } from "vitest";
import { toUserMessage } from "./errors";

describe("toUserMessage", () => {
  it("不把 Tauri 状态未注册错误误报成网络故障", () => {
    expect(toUserMessage(
      "state not managed for field `memory_db` on command `chat_start`. You must call `.manage()` before using this command",
      "网络好像不太稳定",
    )).toBe("应用内部服务未正确初始化，请更新应用或重启后重试。");
  });
  it("把常见英文网络错误映射成可行动的中文提示", () => {
    expect(toUserMessage(new Error("TypeError: Failed to fetch"))).toBe("网络连接失败，请检查网络后重试。");
    expect(toUserMessage("Error: request timed out")).toBe("请求超时，请稍后重试。");
    expect(toUserMessage(new Error("401 Unauthorized"))).toContain("API Key 无效");
  });

  it("保留后端已经写好的中文文案", () => {
    expect(toUserMessage(new Error("目标文件已存在"))).toBe("目标已存在。");
    expect(toUserMessage("提醒时间不能早于当前时间")).toBe("提醒时间不能早于当前时间");
  });

  it("不把技术噪音直出给用户", () => {
    expect(toUserMessage(new Error("Error: ECONNRESET at 0x1f"))).toBe("网络连接失败，请检查网络后重试。");
    expect(toUserMessage("TypeError: x is not a function")).toBe("操作失败，请重试。");
  });

  it("不直出堆栈与多行 panic，只取第一行", () => {
    const stacked = new Error("网络连接失败，请检查网络后重试。\n    at foo (bar.ts:1:1)\n    at baz (qux.ts:2:2)");
    expect(toUserMessage(stacked)).toBe("网络连接失败，请检查网络后重试。");
  });

  it("对空值与不可读对象退回兜底文案", () => {
    expect(toUserMessage(undefined)).toBe("操作失败，请重试。");
    expect(toUserMessage(null)).toBe("操作失败，请重试。");
    expect(toUserMessage("")).toBe("操作失败，请重试。");
    expect(toUserMessage(new Error(""))).toBe("操作失败，请重试。");
    expect(toUserMessage("undefined")).toBe("操作失败，请重试。");
    expect(toUserMessage("[object Object]")).toBe("操作失败，请重试。");
  });

  it("支持自定义兜底文案", () => {
    expect(toUserMessage(new Error("boom"), "删除失败，请重试。")).toBe("删除失败，请重试。");
  });

  it("解包 Tauri 常见的 { message } / StringError(\"...\") 包装", () => {
    expect(toUserMessage({ message: "目标文件已存在" })).toBe("目标已存在。");
    expect(toUserMessage('StringError("网络连接失败，请检查网络后重试。")')).toBe("网络连接失败，请检查网络后重试。");
  });

  it("过长文案会截断，避免刷屏", () => {
    const long = `这是一段很长的中文错误文案${"很".repeat(400)}`;
    const result = toUserMessage(new Error(long));
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith("…")).toBe(true);
  });
});
