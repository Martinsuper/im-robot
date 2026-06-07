// 类型定义
export type {
  OutfitCategory,
  OutfitUnlockState,
  OutfitItem,
  OutfitState,
  OutfitChangeCallback,
  OutfitCatalog,
} from "./outfitTypes";

export { defaultOutfitState, defaultOutfitCatalog } from "./outfitTypes";

// 装扮管理器
export { OutfitManager, outfitManager } from "./OutfitManager";

// 素材加载器
export { OutfitLoader, outfitLoader } from "./OutfitLoader";

// 装扮渲染器
export { OutfitRenderer, createOutfitRenderer } from "./OutfitRenderer";
