// 装扮类别
export type OutfitCategory = "hat" | "accessory" | "background" | "effect";

// 装扮状态
export type OutfitUnlockState = "locked" | "unlocked";

// 装扮物品接口
export interface OutfitItem {
  id: string;
  name: string;
  category: OutfitCategory;
  description: string;
  unlockState: OutfitUnlockState;
  thumbnailPath: string;
  assetPath: string;
  animationFrames?: number;
  animationDuration?: number;
}

// 装扮状态接口
export interface OutfitState {
  hat: string | null;
  accessory: string | null;
  background: string | null;
  effect: string | null;
}

// 装扮变化回调类型
export type OutfitChangeCallback = (state: OutfitState) => void;

// 装扮目录配置
export interface OutfitCatalog {
  hats: OutfitItem[];
  accessories: OutfitItem[];
  backgrounds: OutfitItem[];
  effects: OutfitItem[];
}

// 默认装扮状态
export const defaultOutfitState: OutfitState = {
  hat: null,
  accessory: null,
  background: null,
  effect: null,
};

// 默认装扮目录
export const defaultOutfitCatalog: OutfitCatalog = {
  hats: [],
  accessories: [],
  backgrounds: [],
  effects: [],
};
