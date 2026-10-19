// Compiled by tsc; intentionally never executed. These failures prove the generated boundary.
import { invokeCommand, type CommandInvoker } from "./ipc";
export function proveIpcTypes(legacy: CommandInvoker) {
  void invokeCommand("get_pet_state", {});
  void invokeCommand("save_pet_state", {
    key: "piko-pet-growth-state",
    value: "{}",
    expectedRevision: 1,
    origin: "test",
  });
  // @ts-expect-error unknown commands are rejected
  void invokeCommand("does_not_exist", {});
  void invokeCommand("save_pet_state", {
    key: "x",
    value: null,
    // @ts-expect-error revisions must be numeric
    expectedRevision: "1",
    origin: "test",
  });
  // @ts-expect-error a required field cannot be omitted
  void invokeCommand("agent_approve", { requestId: "a", allowed: true });
  // @ts-expect-error compatibility callers also need the command arguments
  void legacy("agent_approve");
  // @ts-expect-error misspelled arguments are rejected
  void legacy("preview_data_snapshot", { folder: "/tmp" });
}
