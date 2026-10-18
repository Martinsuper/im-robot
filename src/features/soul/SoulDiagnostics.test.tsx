// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SoulDiagnostics } from "./SoulDiagnostics";
import type { SoulDiagnostics as Diagnostics } from "./types";

const command = vi.hoisted(() => vi.fn());
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: command }));
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../panel/PanelChrome", () => ({ SettingsGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
afterEach(() => { cleanup(); command.mockReset(); });

const healthy: Diagnostics = { storage: "available", schema_version: 1, profile_valid: true,
  ledger_readable: true, proactive_enabled: false, issues: [] };

it("keeps ledger failure visible and does not present an enable action", async () => {
  command.mockResolvedValue({ ...healthy, ledger_readable: false, issues: ["ledger_unreadable"] });
  render(<SoulDiagnostics />);
  expect(await screen.findByText("soul.ledgerBlocked")).toBeTruthy();
  expect(screen.getByText("soul.rolloutPending")).toBeTruthy();
  expect(command).toHaveBeenCalledWith("soul_diagnostics");
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("shows command failure and lets the user recheck storage", async () => {
  command.mockRejectedValueOnce(new Error("private database details"));
  render(<SoulDiagnostics />);
  expect(await screen.findByText("soul.loadFailed")).toBeTruthy();
  expect(screen.queryByText("private database details")).toBeNull();
  command.mockResolvedValue(healthy);
  fireEvent.click(screen.getByRole("button", { name: "soul.refresh" }));
  await waitFor(() => expect(screen.getByText("soul.ledgerHealthy")).toBeTruthy());
  expect(screen.getByText("soul.profileHealthy")).toBeTruthy();
});
