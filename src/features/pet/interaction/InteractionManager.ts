import {
  createClickEvent,
  createDoubleClickEvent,
  createHoverEvent,
  createPetEvent,
  createChatStartEvent,
  createChatCompleteEvent,
  createFileDropEvent,
  createFileProcessEvent,
  createSurpriseEvent,
  EmotionTriggers,
} from "../emotion";
import type { EmotionEvent } from "../emotion";
import type { HumanInteractionEvent, InteractionContext, PetInteractionResult } from "./interactionTypes";

const emotionTriggers = new EmotionTriggers();

function toQuietModeLevel(quietMode: InteractionContext["quietMode"]) {
  return quietMode === "active" ? "expressive" : quietMode;
}

export class InteractionManager {
  handle(event: HumanInteractionEvent, context: InteractionContext): PetInteractionResult {
    const mode = toQuietModeLevel(context.quietMode);
    const result = this.resolve(event, context, mode);

    if (mode === "minimal") {
      return {
        ...result,
        sound: undefined,
        openBubble: result.openBubble && event.type === "click",
      };
    }

    return result;
  }

  private resolve(
    event: HumanInteractionEvent,
    context: InteractionContext,
    mode: "minimal" | "balanced" | "expressive"
  ): PetInteractionResult {
    const intimacyTier = context.intimacy > 40 ? "close" : context.intimacy > 12 ? "warm" : "new";
    const isChatty = context.recentInteractionCount > 12;

    switch (event.type) {
      case "click":
        return this.emit(createClickEvent(0, 0), {
          petEvent: { type: "INTERACT" },
          sound: intimacyTier === "close" ? "greet" : "click",
          openBubble: true,
          saveStats: true,
        });
      case "double_click":
        return this.emit(createDoubleClickEvent(0, 0), {
          petEvent: { type: context.isResting ? "WAKE" : "REST" },
          sound: context.isResting ? "wake" : "greet",
          saveStats: true,
        });
      case "hover":
        return this.emit(createHoverEvent(0, 0), {
          petEvent: { type: "HOVER" },
          emotion: "curious",
          sound: mode === "expressive" && !isChatty ? "notice" : undefined,
          saveStats: true,
        });
      case "hover_leave":
        return {
          petEvent: { type: "RESET" },
          saveStats: false,
        };
      case "pet_stroke":
        return this.emit(createPetEvent(), {
          petEvent: { type: "PET_STROKED" },
          emotion: "happy",
          sound: intimacyTier === "new" ? "greet" : "celebrate",
          saveStats: true,
        });
      case "drag_start":
        return {
          petEvent: { type: "DRAG_STARTED" },
          emotion: "surprised",
          sound: mode === "minimal" ? undefined : "notice",
          saveStats: true,
        };
      case "drag_end":
        return {
          petEvent: { type: "DRAG_RELEASED" },
          emotion: "playful",
          sound: mode === "expressive" ? "greet" : undefined,
          saveStats: true,
        };
      case "drop_file":
        return this.emit(
          createFileDropEvent(event.payload?.fileName ?? "attachment", event.payload?.fileSize ?? 0),
          {
            petEvent: { type: "ATTACHMENT_READY" },
            emotion: "excited",
            sound: "drop",
            saveStats: true,
          }
        );
      case "drop_text":
        return this.emit(createFileProcessEvent(event.payload?.fileName ?? "text"), {
          petEvent: { type: "LISTEN" },
          emotion: "curious",
          sound: "curious",
          openBubble: true,
          saveStats: true,
        });
      case "chat_open":
        return this.emit(createChatStartEvent(event.payload?.message ?? ""), {
          petEvent: { type: "LISTEN" },
          emotion: "curious",
          openBubble: true,
          saveStats: true,
        });
      case "chat_submitted":
        return this.emit(createChatStartEvent(event.payload?.message ?? ""), {
          petEvent: { type: "CHAT_SUBMITTED" },
          emotion: "curious",
          sound: "notice",
          saveStats: true,
        });
      case "chat_completed":
        return this.emit(createChatCompleteEvent(event.payload?.message ?? ""), {
          petEvent: { type: "CHAT_COMPLETED" },
          emotion: "happy",
          sound: "celebrate",
          saveStats: true,
        });
      case "user_idle_started":
        return {
          petEvent: { type: "REST" },
          emotion: "sleepy",
          saveStats: true,
        };
      case "user_idle_ended":
        return {
          petEvent: { type: "WAKE" },
          emotion: "happy",
          sound: "wake",
          saveStats: true,
        };
      case "focus_started":
        return {
          petEvent: { type: "WORK_STARTED" },
          emotion: "thoughtful",
          saveStats: true,
        };
      case "focus_completed":
        return this.emit(createSurpriseEvent(event.payload?.message ?? ""), {
          petEvent: { type: "CHAT_COMPLETED" },
          emotion: "happy",
          sound: "celebrate",
          saveStats: true,
        });
      case "long_press":
        return {
          petEvent: { type: "HOVER_DROP" },
          emotion: "curious",
          openPanel: false,
          saveStats: false,
        };
      default:
        return {};
    }
  }

  private emit(emotionEvent: EmotionEvent, result: PetInteractionResult): PetInteractionResult {
    const trigger = emotionTriggers.processEvent(emotionEvent);
    return {
      ...result,
      event: emotionEvent,
      emotion: result.emotion ?? trigger?.emotion,
    };
  }
}
