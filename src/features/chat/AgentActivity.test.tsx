// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentActivity } from "./AgentActivity";

afterEach(cleanup);
const base = { tools: [], approvals: [], workspaceRequired: false, status: "", onApprove: vi.fn(), onChooseWorkspace: vi.fn(), onCancelWorkspace: vi.fn() };
it("shows approval in the reply without another input or automatic approval", () => {
  const onApprove = vi.fn();
  const { container } = render(<AgentActivity {...base} onApprove={onApprove} approvals={[{ id: "a", tool: "bash", arguments: { command: "pwd" } }]} />);
  expect(container.querySelectorAll("input, textarea, form")).toHaveLength(0);
  expect(onApprove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("允许此次操作"));
  expect(onApprove).toHaveBeenCalledWith("a", true);
});
it("requests a directory only when the running task needs one", () => {
  const choose = vi.fn(), cancel = vi.fn();
  render(<AgentActivity {...base} workspaceRequired onChooseWorkspace={choose} onCancelWorkspace={cancel} />);
  fireEvent.click(screen.getByText("选择文件夹并继续"));
  fireEvent.click(screen.getByText("取消此次操作"));
  expect(choose).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
});
