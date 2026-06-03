import { invoke } from "@tauri-apps/api/core";

export const isTauriRuntime = "__TAURI_INTERNALS__" in window;

export function runCommand<T>(command: string, args?: Record<string, unknown>, fallback?: T) {
  return isTauriRuntime ? invoke<T>(command, args) : Promise.resolve(fallback as T);
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
