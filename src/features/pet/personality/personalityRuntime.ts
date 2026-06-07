import type { HumanInteractionEvent } from "../interaction/interactionTypes";
import { DEFAULT_PERSONALITY, type InteractionRecord, type PersonalityDimensions } from "./personalityTypes";

const PERSONALITY_STORAGE_KEY = "piko-personality-state";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isPersonalityDimensions(value: unknown): value is PersonalityDimensions {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersonalityDimensions>;
  return (
    typeof candidate.energy === "number" &&
    typeof candidate.humor === "number" &&
    typeof candidate.curiosity === "number"
  );
}

export function loadPersonalityState(fallback: PersonalityDimensions = DEFAULT_PERSONALITY): PersonalityDimensions {
  if (!canUseStorage()) return { ...fallback };
  try {
    const raw = window.localStorage.getItem(PERSONALITY_STORAGE_KEY);
    if (!raw) return { ...fallback };
    const parsed = JSON.parse(raw) as unknown;
    return isPersonalityDimensions(parsed) ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export function savePersonalityState(state: PersonalityDimensions): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(PERSONALITY_STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent<PersonalityDimensions>("piko-personality-state-changed", { detail: state }));
  } catch {
    // ignore persistence failures
  }
}

export function clearPersonalityState(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(PERSONALITY_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent<PersonalityDimensions>("piko-personality-state-changed", { detail: DEFAULT_PERSONALITY }));
  } catch {
    // ignore persistence failures
  }
}

export function recordPersonalitySignalFromInteraction(
  event: Pick<HumanInteractionEvent, "type" | "intensity">
): InteractionRecord | null {
  const timestamp = Date.now();

  switch (event.type) {
    case "click":
      return { type: "click", timestamp, intensity: event.intensity ?? 0.4 };
    case "double_click":
      return { type: "click", timestamp, intensity: Math.max(0.5, event.intensity ?? 0.7) };
    case "hover":
      return { type: "idle", timestamp, intensity: 0.25 };
    case "pet_stroke":
      return { type: "celebrate", timestamp, intensity: Math.max(0.6, event.intensity ?? 0.8) };
    case "drag_start":
    case "drag_end":
      return { type: "drag", timestamp, intensity: event.intensity ?? 0.7 };
    case "drop_file":
    case "drop_text":
      return { type: "drop", timestamp, intensity: event.intensity ?? 0.7 };
    case "chat_open":
    case "chat_submitted":
      return { type: "chat", timestamp, intensity: event.intensity ?? 0.5 };
    case "chat_completed":
      return { type: "celebrate", timestamp, intensity: event.intensity ?? 0.9 };
    case "user_idle_started":
    case "ambient_nudge":
    case "break_reminder":
      return { type: "idle", timestamp, intensity: event.intensity ?? 1 };
    case "user_idle_ended":
      return { type: "idle", timestamp, intensity: 0.2 };
    case "focus_started":
      return { type: "work", timestamp, intensity: event.intensity ?? 0.7 };
    case "focus_completed":
      return { type: "celebrate", timestamp, intensity: event.intensity ?? 0.8 };
    case "FAILED":
      return { type: "work", timestamp, intensity: 0.8 };
    default:
      return null;
  }
}
