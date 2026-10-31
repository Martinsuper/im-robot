import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AgentPolicy, ContractMilestone, ContractObject, GitMode, PendingContract, PolicyPreset } from "./agentTypes";
import { POLICY_PRESETS } from "./agentTypes";
import { useTranslation } from "../i18n/I18nProvider";
import "./contractCard.css";

const GIT_MODES: GitMode[] = ["branch", "files-only", "off"];
const PRESET_ORDER: PolicyPreset[] = ["cautious", "standard", "trusted"];

const POLICY_LABELS: Record<PolicyPreset, { key: string; fallback: string }> = {
  cautious: { key: "chat.task.policy.cautious", fallback: "谨慎（全部操作先确认）" },
  standard: { key: "chat.task.policy.standard", fallback: "标准（文件自动，命令先确认）" },
  trusted: { key: "chat.task.policy.trusted", fallback: "信任（命令也自动，危险命令除外）" },
};
const POLICY_HINTS: Record<PolicyPreset, { key: string; fallback: string }> = {
  cautious: { key: "chat.task.policyHint.cautious", fallback: "每一步写文件与命令都先征求同意。" },
  standard: { key: "chat.task.policy.standard", fallback: "工作区内写文件自动执行，命令与工作区外写入先确认。" },
  trusted: { key: "chat.task.policy.trusted", fallback: "常用命令也自动执行；高危命令与工作区外写入仍会确认。" },
};
const GIT_LABELS: Record<GitMode, { key: string; fallback: string }> = {
  branch: { key: "chat.task.git.branch", fallback: "新建任务分支并按里程碑提交" },
  "files-only": { key: "chat.task.git.files-only", fallback: "不建分支，仅提交任务触碰的文件" },
  off: { key: "chat.task.git.off", fallback: "不使用 git 安全网" },
};

function contractForConfirmation(contract: ContractObject, milestones: ContractMilestone[], verifyCommand: string, timeMinutes: number): ContractObject {
  return {
    goal: contract.goal,
    milestones,
    verifyCommand: verifyCommand.trim(),
    timeMinutes: timeMinutes > 0 ? Math.round(timeMinutes) : 0,
    risks: contract.risks,
  };
}

export function ContractCard({ pending, disabled = false, onConfirm, onReject }: {
  pending: PendingContract;
  disabled?: boolean;
  onConfirm: (contract: ContractObject, policy: AgentPolicy, gitMode: GitMode) => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const milestoneKey = useRef(0);
  const [milestones, setMilestones] = useState<ContractMilestone[]>(() => pending.contract.milestones.map((milestone) => ({ ...milestone })));
  const [verifyCommand, setVerifyCommand] = useState(pending.contract.verifyCommand);
  const [timeMinutes, setTimeMinutes] = useState(String(pending.contract.timeMinutes || ""));
  const [preset, setPreset] = useState<PolicyPreset>("standard");
  const [gitMode, setGitMode] = useState<GitMode>("branch");

  function updateMilestone(id: string, patch: Partial<ContractMilestone>) {
    setMilestones((current) => current.map((milestone) => milestone.id === id ? { ...milestone, ...patch } : milestone));
  }
  function addMilestone() {
    milestoneKey.current += 1;
    setMilestones((current) => [...current, { id: `m-user-${milestoneKey.current}`, title: "", acceptance: "" }]);
  }
  function removeMilestone(id: string) {
    setMilestones((current) => current.filter((milestone) => milestone.id !== id));
  }
  function confirm() {
    const minutes = Number(timeMinutes);
    onConfirm(
      contractForConfirmation(pending.contract, milestones, verifyCommand, Number.isFinite(minutes) ? minutes : 0),
      POLICY_PRESETS[preset],
      gitMode,
    );
  }

  return <section className="contract-card" aria-label={t("chat.task.contract.ariaLabel", "任务契约待确认")}>
    <p className="eyebrow">CONTRACT</p>
    <strong>{t("chat.task.contract.title", "任务契约")}</strong>
    {pending.contract.goal && <p className="contract-card__goal">{pending.contract.goal}</p>}
    <h4>{t("chat.task.contract.milestones", "里程碑")}</h4>
    <div className="contract-card__milestones">
      {milestones.map((milestone) => <div className="contract-card__milestone" key={milestone.id}>
        <input aria-label={t("chat.task.contract.milestoneTitle", "里程碑标题")} placeholder={t("chat.task.contract.milestoneTitle", "里程碑标题")}
          value={milestone.title} maxLength={120} disabled={disabled}
          onChange={(event) => updateMilestone(milestone.id, { title: event.target.value })} />
        <input aria-label={t("chat.task.contract.milestoneAcceptance", "该里程碑的验收描述")} placeholder={t("chat.task.contract.milestoneAcceptance", "该里程碑的验收描述")}
          value={milestone.acceptance} maxLength={240} disabled={disabled}
          onChange={(event) => updateMilestone(milestone.id, { acceptance: event.target.value })} />
        <button type="button" className="contract-card__remove" aria-label={t("chat.task.contract.removeMilestone", "删除里程碑")}
          disabled={disabled} onClick={() => removeMilestone(milestone.id)}><Trash2 size={13} /></button>
      </div>)}
    </div>
    <button type="button" className="contract-card__add" onClick={addMilestone} disabled={disabled}>
      <Plus size={13} /> {t("chat.task.contract.addMilestone", "添加里程碑")}
    </button>
    <label className="contract-card__field">
      {t("chat.task.contract.verifyCommand", "验收命令")}
      <input value={verifyCommand} maxLength={200} placeholder="npm run verify" disabled={disabled}
        onChange={(event) => setVerifyCommand(event.target.value)} />
    </label>
    <label className="contract-card__field contract-card__field--narrow">
      {t("chat.task.contract.timeMinutes", "时间预算（分钟，0 为不限）")}
      <input type="number" min={0} step={5} value={timeMinutes} disabled={disabled}
        onChange={(event) => setTimeMinutes(event.target.value)} />
    </label>
    <fieldset className="contract-card__group">
      <legend>{t("chat.task.contract.policy", "自主档位")}</legend>
      {PRESET_ORDER.map((option) => <label key={option}>
        <input type="radio" name={`contract-policy-${pending.contractId}`} checked={preset === option} disabled={disabled}
          onChange={() => setPreset(option)} />
        <span>{t(POLICY_LABELS[option].key, POLICY_LABELS[option].fallback)}</span>
      </label>)}
      <small>{t(POLICY_HINTS[preset].key, POLICY_HINTS[preset].fallback)}</small>
    </fieldset>
    <fieldset className="contract-card__group">
      <legend>{t("chat.task.contract.gitMode", "git 模式")}</legend>
      {GIT_MODES.map((option) => <label key={option}>
        <input type="radio" name={`contract-git-${pending.contractId}`} checked={gitMode === option} disabled={disabled}
          onChange={() => setGitMode(option)} />
        <span>{t(GIT_LABELS[option].key, GIT_LABELS[option].fallback)}</span>
      </label>)}
      {gitMode === "branch" && <small>{t("chat.task.contract.dirtyHint", "工作区有未提交改动时，宿主会改为仅提交本任务触碰的文件，不会动你的其他改动。")}</small>}
    </fieldset>
    {pending.contract.risks.length > 0 && <div>
      <h4>{t("chat.task.contract.risks", "风险提示")}</h4>
      <ul className="contract-card__risks">{pending.contract.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
    </div>}
    <div className="contract-card__actions">
      <button type="button" disabled={disabled} onClick={confirm}>{t("chat.task.contract.approve", "确认并开始执行")}</button>
      <button type="button" className="is-secondary" disabled={disabled} onClick={onReject}>{t("chat.task.contract.reject", "放弃任务")}</button>
    </div>
  </section>;
}
