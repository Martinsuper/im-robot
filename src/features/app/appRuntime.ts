import { flushPersistentState } from "../../lib/persistentState";
import {
  commandNames,
  IpcFailure,
  invokeCommand,
  type CommandName,
  type CommandMap,
} from "../../generated/ipc";
import { invoke } from "@tauri-apps/api/core";

export const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function runCommand<K extends CommandName>(
  command: K,
  ...rest: {} extends CommandMap[K]["args"]
    ? [args?: CommandMap[K]["args"], fallback?: unknown]
    : [args: CommandMap[K]["args"], fallback?: unknown]
): Promise<CommandMap[K]["result"]> {
  const [args, fallback] = rest;
  if (!(commandNames as readonly string[]).includes(command))
    return Promise.reject(new Error(`Unknown IPC command: ${command}`));
  if (["export_data", "import_data", "clear_my_data"].includes(command))
    await flushPersistentState();
  return isTauriRuntime
    ? invoke<CommandMap[K]["result"]>(command, args as Record<string, unknown> | undefined).catch((error: unknown) => {
        throw new IpcFailure(
          command,
          "backend_error",
          error instanceof Error ? error.message : String(error),
        );
      })
    : (fallback as CommandMap[K]["result"]);
}

/**
 * Fire-and-forget 调用：失败时上报到 console 而不是产生 unhandled rejection。
 * 适用于不关心返回值、也不需要在 UI 上反馈失败的命令。
 */
export function runCommandQuiet<K extends CommandName>(
  command: K,
  ...args: {} extends CommandMap[K]["args"]
    ? [args?: CommandMap[K]["args"]]
    : [args: CommandMap[K]["args"]]
): void {
  if (!isTauriRuntime) return;
  void invokeCommand(command, args[0] ?? ({} as CommandMap[K]["args"])).catch(
    reportCommandError(command),
  );
}

/** 生成 `.catch` 用的错误上报函数：`.then(handler).catch(reportCommandError("cmd"))` */
export function reportCommandError(command: string): (error: unknown) => void {
  return (error) => {
    console.error(`[piko] ${command} failed:`, error);
  };
}
