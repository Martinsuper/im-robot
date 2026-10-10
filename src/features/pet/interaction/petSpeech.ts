import { DialogueSystem } from "../personality";
import type { BondTier, PersonalityDimensions } from "../personality";
import { generatePetCompanionResponse } from "./petAi";

const dialogueSystem = new DialogueSystem();

const fallbackPersonality: PersonalityDimensions = {
  energy: 0,
  humor: 0,
  curiosity: 0,
};

function getSceneForInteraction(type: string) {
  switch (type) {
    case "click":
    case "chat_open":
    case "user_idle_ended":
      return "greeting";
    case "double_click":
    case "pet_stroke":
    case "drag_end":
      return "playful";
    case "drop_file":
    case "drop_text":
    case "hover":
      return "curious";
    case "focus_started":
      return "working";
    case "focus_completed":
      return "celebrate";
    case "user_idle_started":
    case "ambient_nudge":
    case "break_reminder":
      return "sleepy";
    case "FAILED":
      return "error";
    default:
      return "idle";
  }
}

/** i18n 翻译函数的可选注入形态（与 useTranslation().t 一致，见 appShared 的 reminderRepeatLabel 模式） */
type Translate = (key: string, fallback?: string) => string;

const companionHereFallback = "Piko 在这里陪着你。";

export function getPetSpeechFallbackForInteraction(
  type: string,
  bondTier: BondTier,
  personality: PersonalityDimensions = fallbackPersonality,
  translate?: Translate
): string {
  const scene = getSceneForInteraction(type);
  const dialogue = dialogueSystem.getBondAwareDialogue(scene, personality, bondTier);
  if (dialogue?.text) {
    return dialogue.text;
  }
  return translate ? translate("pet.speech.companionHere", companionHereFallback) : companionHereFallback;
}

export async function getPetSpeechForInteraction(
  type: string,
  bondTier: BondTier,
  personality: PersonalityDimensions = fallbackPersonality,
  personalitySummary?: string,
  translate?: Translate
): Promise<string> {
  const scene = getSceneForInteraction(type);
  const generated = await generatePetCompanionResponse({
    mode: "dialogue",
    scene,
    bondTier,
    interactionType: type,
    personality,
    personalitySummary,
    context: "请生成一句适合当前场景与关系阶段的中文宠物台词，要求自然、短句、温柔。"
  });

  if (generated?.message) {
    return generated.message;
  }

  return getPetSpeechFallbackForInteraction(type, bondTier, personality, translate);
}
