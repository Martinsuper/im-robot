// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WindowErrorBoundary } from "./WindowErrorBoundary";
vi.mock("../../features/i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shows recovery controls and retries a failed child", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let failing = true;
  function Child() { if (failing) throw new Error("render failure"); return <p>Recovered</p>; }
  render(<WindowErrorBoundary><Child /></WindowErrorBoundary>);
  expect(screen.getByRole("alert").textContent).toContain("页面暂时无法显示");
  failing = false; fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(screen.getByText("Recovered")).toBeTruthy();
});
it("handles unavailable clipboard without another render failure", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Child(): never { throw new Error("render failure"); }
  render(<WindowErrorBoundary><Child /></WindowErrorBoundary>);
  fireEvent.click(screen.getByRole("button", { name: "复制诊断信息" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("无法复制"));
});
