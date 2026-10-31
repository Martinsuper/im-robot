// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
import { ContractCard } from "./ContractCard";
import type { PendingContract } from "./agentTypes";

afterEach(cleanup);

const pending: PendingContract = {
  contractId: "contract-1",
  contract: {
    goal: "重构登录模块",
    milestones: [{ id: "m1", title: "定位问题", acceptance: "复现路径明确" }],
    verifyCommand: "npm run verify",
    timeMinutes: 90,
    risks: ["会改动鉴权中间件"],
  },
};

it("renders the contract draft with editable milestones, verify command and budget", () => {
  render(<ContractCard pending={pending} onConfirm={vi.fn()} onReject={vi.fn()} />);
  expect(screen.getByText("重构登录模块")).toBeTruthy();
  const title = screen.getByLabelText("里程碑标题") as HTMLInputElement;
  const acceptance = screen.getByLabelText("该里程碑的验收描述") as HTMLInputElement;
  expect(title.value).toBe("定位问题");
  expect(acceptance.value).toBe("复现路径明确");
  fireEvent.change(title, { target: { value: "定位并修复" } });
  expect(title.value).toBe("定位并修复");
  const verify = screen.getByLabelText("验收命令") as HTMLInputElement;
  fireEvent.change(verify, { target: { value: "npm run check" } });
  expect(verify.value).toBe("npm run check");
  const budget = screen.getByLabelText("时间预算（分钟，0 为不限）") as HTMLInputElement;
  fireEvent.change(budget, { target: { value: "45" } });
  expect(screen.getByText("会改动鉴权中间件")).toBeTruthy();
});

it("adds and removes milestones before confirming", () => {
  render(<ContractCard pending={pending} onConfirm={vi.fn()} onReject={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "添加里程碑" }));
  expect(screen.getAllByLabelText("里程碑标题")).toHaveLength(2);
  const removeButtons = screen.getAllByRole("button", { name: "删除里程碑" });
  fireEvent.click(removeButtons[removeButtons.length - 1]);
  expect(screen.getAllByLabelText("里程碑标题")).toHaveLength(1);
});

it("maps the chosen autonomy preset and git mode into the confirmation", () => {
  const onConfirm = vi.fn();
  render(<ContractCard pending={pending} onConfirm={onConfirm} onReject={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "谨慎（全部操作先确认）" }));
  expect(screen.getByText("每一步写文件与命令都先征求同意。")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "不使用 git 安全网" }));
  fireEvent.click(screen.getByRole("button", { name: "确认并开始执行" }));
  expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
    goal: "重构登录模块", verifyCommand: "npm run verify", timeMinutes: 90,
  }), { workspaceFiles: "confirm", shell: "confirm", outsideWorkspace: "confirm" }, "off");
});

it("sends the edited contract and the default standard policy on confirm", async () => {
  const onConfirm = vi.fn();
  render(<ContractCard pending={pending} onConfirm={onConfirm} onReject={vi.fn()} />);
  const title = screen.getByLabelText("里程碑标题");
  fireEvent.change(title, { target: { value: "修复" } });
  fireEvent.click(screen.getByRole("button", { name: "添加里程碑" }));
  const added = screen.getAllByLabelText("里程碑标题")[1] as HTMLInputElement;
  fireEvent.change(added, { target: { value: "回归验证" } });
  fireEvent.click(screen.getByRole("button", { name: "确认并开始执行" }));
  await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  const [contract, policy, gitMode] = onConfirm.mock.calls[0];
  expect(contract.milestones).toEqual([
    { id: "m1", title: "修复", acceptance: "复现路径明确" },
    { id: expect.stringContaining("m-user-"), title: "回归验证", acceptance: "" },
  ]);
  expect(policy).toEqual({ workspaceFiles: "auto", shell: "confirm", outsideWorkspace: "confirm" });
  expect(gitMode).toBe("branch");
  expect(screen.getByText(/工作区有未提交改动时/)).toBeTruthy();
});

it("rejecting reports the cancel decision without edits", () => {
  const onReject = vi.fn();
  render(<ContractCard pending={pending} onConfirm={vi.fn()} onReject={onReject} />);
  fireEvent.click(screen.getByRole("button", { name: "放弃任务" }));
  expect(onReject).toHaveBeenCalledOnce();
});
