import { invoke } from "@tauri-apps/api/core";

export const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function runCommand<T>(command: string, args?: Record<string, unknown>, fallback?: T) {
  return isTauriRuntime ? invoke<T>(command, args) : Promise.resolve(fallback as T);
}

/**
 * Fire-and-forget 调用：失败时上报到 console 而不是产生 unhandled rejection。
 * 适用于不关心返回值、也不需要在 UI 上反馈失败的命令。
 */
export function runCommandQuiet(command: string, args?: Record<string, unknown>): void {
  runCommand(command, args).catch(reportCommandError(command));
}

/** 生成 `.catch` 用的错误上报函数：`.then(handler).catch(reportCommandError("cmd"))` */
export function reportCommandError(command: string): (error: unknown) => void {
  return (error) => {
    console.error(`[piko] ${command} failed:`, error);
  };
}

export async function runCommandAndRefresh<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  refreshers: Array<() => Promise<void> | void>,
  fallback?: T,
) {
  const result = await runCommand<T>(command, args, fallback);
  if (!isTauriRuntime) {
    await Promise.all(refreshers.map((refresh) => Promise.resolve(refresh())));
  }
  return result;
}
