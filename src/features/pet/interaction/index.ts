export type {
  HumanInteractionType,
  HumanInteractionEvent,
  InteractionContext,
  PetInteractionResult,
  InteractionStats,
} from "./interactionTypes";
export { DEFAULT_INTERACTION_STATS } from "./interactionTypes";
export { InteractionManager } from "./InteractionManager";
export { applyInteractionGrowth, loadGrowthSnapshot, type GrowthSnapshot } from "./interactionGrowth";
export { getPetSpeechForInteraction, getPetSpeechFallbackForInteraction } from "./petSpeech";
export {
  generatePetCompanionResponse,
  resolvePetIdleMotionStyle,
  resolvePetBehaviorProfile,
  resolvePetBehaviorPriority,
  type PetCompanionGenerationInput,
  type PetCompanionGenerationOutput,
  type PetBehaviorProfile,
  type PetBehaviorPriority,
  type PetMotionStyle,
} from "./petAi";
export {
  loadInteractionStats,
  saveInteractionStats,
  recordInteractionStats,
  storeInteractionStats,
} from "./interactionStorage";
