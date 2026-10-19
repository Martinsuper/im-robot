import { readPersistentState, writePersistentState } from "../../../lib/persistentState";
import { DEFAULT_INTERACTION_STATS, type HumanInteractionEvent, type InteractionStats } from "./interactionTypes";

const INTERACTION_STATS_KEY = "piko-interaction-stats";

function canUseStorage() {
  return typeof window !== "undefined";
}

export function loadInteractionStats(): InteractionStats {
  if (!canUseStorage()) return { ...DEFAULT_INTERACTION_STATS };

  try {
    const raw = readPersistentState(INTERACTION_STATS_KEY);
    if (!raw) return { ...DEFAULT_INTERACTION_STATS };
    const parsed = JSON.parse(raw) as Partial<InteractionStats>;
    return {
      ...DEFAULT_INTERACTION_STATS,
      ...parsed,
      lastInteractionAt: typeof parsed.lastInteractionAt === "number" ? parsed.lastInteractionAt : null,
    };
  } catch (error) {
    // 降级为默认值，不打扰用户：localStorage 每次进入页面都会读，
    // 失败（隐私模式 / 配额 / 脏数据）时弹窗会持续骚扰，且用户无能为力。
    console.warn("[interactionStorage] 读取失败", error);
    return { ...DEFAULT_INTERACTION_STATS };
  }
}

export function saveInteractionStats(stats: InteractionStats): void {
  if (!canUseStorage()) return;
  try {
    writePersistentState(INTERACTION_STATS_KEY, JSON.stringify(stats));
    window.dispatchEvent(new CustomEvent<InteractionStats>("piko-interaction-stats-changed", { detail: stats }));
  } catch (error) {
    // 忽略存储失败，交互不应被本地持久化错误阻断。
    // 降级为「本次不持久化」，不打扰用户：每次交互都会写一次，弹窗会刷屏。
    console.warn("[interactionStorage] 写入失败", error);
  }
}

export function recordInteractionStats(
  event: HumanInteractionEvent,
  current: InteractionStats = loadInteractionStats()
): InteractionStats {
  const next: InteractionStats = {
    ...current,
    totalInteractions: current.totalInteractions + 1,
    lastInteractionAt: event.timestamp,
  };

  switch (event.type) {
    case "click":
      next.clickCount += 1;
      next.intimacy += 1;
      break;
    case "double_click":
      next.doubleClickCount += 1;
      next.intimacy += 1.5;
      break;
    case "hover":
      next.hoverCount += 1;
      break;
    case "pet_stroke":
      next.petStrokeCount += 1;
      next.intimacy += 2;
      break;
    case "drag_start":
    case "drag_end":
    case "drag_move":
      next.dragCount += event.type === "drag_end" ? 1 : 0;
      break;
    case "drop_file":
    case "drop_text":
      next.dropCount += 1;
      next.intimacy += 1.5;
      break;
    case "chat_open":
    case "chat_submitted":
    case "chat_completed":
      next.chatCount += event.type === "chat_completed" ? 1 : 0;
      next.intimacy += event.type === "chat_completed" ? 2 : 0.5;
      break;
    case "focus_started":
    case "focus_completed":
      next.focusCount += event.type === "focus_completed" ? 1 : 0;
      next.intimacy += event.type === "focus_completed" ? 1.5 : 0;
      break;
    default:
      break;
  }

  next.intimacy = Math.max(0, Math.min(1000, next.intimacy));
  return next;
}

export function storeInteractionStats(event: HumanInteractionEvent): InteractionStats {
  const next = recordInteractionStats(event);
  saveInteractionStats(next);
  return next;
}
