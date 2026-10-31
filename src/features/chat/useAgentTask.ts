import { useMemo, useReducer, type SetStateAction } from "react";
import { agentTaskReducer, initialAgentTaskState, type AgentTaskState } from "./agentTaskState";
import type { AgentEvent, AgentTaskSnapshot } from "./agentTypes";

export function useAgentTask() {
  const [state, dispatch] = useReducer(agentTaskReducer, initialAgentTaskState);
  const actions = useMemo(() => {
    function setter<K extends keyof AgentTaskState>(key: K) {
      return (value: SetStateAction<AgentTaskState[K]>) => {
        const update = (current: AgentTaskState[K]) => typeof value === "function"
          ? (value as (current: AgentTaskState[K]) => AgentTaskState[K])(current) : value;
        dispatch({ type: "update", update: (current) => ({ ...current, [key]: update(current[key]) }) });
      };
    }
    return {
      setAgentBusy: setter("busy"),
      setAgentPendingContract: setter("pendingContract"),
      beginAgentTask: (requestId: string) => dispatch({ type: "begin", requestId }),
      restoreAgentTask: (snapshot: AgentTaskSnapshot) => dispatch({ type: "restore", snapshot }),
      resetAgentTask: () => dispatch({ type: "reset" }),
      applyAgentEvent: (event: AgentEvent) => dispatch({ type: "event", event }),
    };
  }, []);
  return { agentBusy: state.busy, agentStatus: state.status, agentTools: state.tools,
    taskTerminal: state.terminal, agentApprovals: state.approvals,
    workspaceRequired: state.workspaceRequired,
    agentPendingContract: state.pendingContract, agentMilestones: state.milestones,
    agentNotices: state.notices, agentReceipt: state.receipt, ...actions };
}
