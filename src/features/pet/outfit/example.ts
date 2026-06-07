/**
 * 装扮系统使用示例
 */

import { outfitManager, outfitLoader } from "./index";
import type { OutfitCatalog, OutfitState } from "./outfitTypes";

// 示例装扮目录
const sampleCatalog: OutfitCatalog = {
  hats: [
    {
      id: "hat-crown",
      name: "皇冠",
      category: "hat",
      description: "闪亮的金色皇冠",
      unlockState: "unlocked",
      thumbnailPath: "/assets/outfits/hats/crown-thumb.png",
      assetPath: "/assets/outfits/hats/crown.png",
    },
    {
      id: "hat-wizard",
      name: "巫师帽",
      category: "hat",
      description: "神秘的巫师帽子",
      unlockState: "locked",
      thumbnailPath: "/assets/outfits/hats/wizard-thumb.png",
      assetPath: "/assets/outfits/hats/wizard.png",
    },
  ],
  accessories: [
    {
      id: "accessory-glasses",
      name: "眼镜",
      category: "accessory",
      description: "时尚的黑框眼镜",
      unlockState: "unlocked",
      thumbnailPath: "/assets/outfits/accessories/glasses-thumb.png",
      assetPath: "/assets/outfits/accessories/glasses.png",
    },
  ],
  backgrounds: [
    {
      id: "bg-space",
      name: "太空背景",
      category: "background",
      description: "星空背景",
      unlockState: "locked",
      thumbnailPath: "/assets/outfits/backgrounds/space-thumb.png",
      assetPath: "/assets/outfits/backgrounds/space.png",
    },
  ],
  effects: [
    {
      id: "effect-sparkle",
      name: "闪光效果",
      category: "effect",
      description: "闪闪发光的效果",
      unlockState: "unlocked",
      thumbnailPath: "/assets/outfits/effects/sparkle-thumb.png",
      assetPath: "/assets/outfits/effects/sparkle.png",
      animationFrames: 8,
      animationDuration: 1000,
    },
  ],
};

// 初始化装扮系统
export function initOutfitSystem(): void {
  // 加载装扮目录
  outfitManager.loadCatalog(sampleCatalog);

  // 注册装扮变化回调
  outfitManager.onChange((state: OutfitState) => {
    console.log("装扮已更新:", state);
    // 这里可以触发UI更新或重新渲染
  });

  // 预加载已解锁的装扮
  const unlockedItems = outfitManager.getUnlockedOutfits();
  outfitLoader.preloadAssets(unlockedItems).then(() => {
    console.log("装扮素材加载完成");
  });
}

// 示例：设置装扮
export function exampleSetOutfit(): void {
  // 设置帽子
  outfitManager.setOutfit("hat", "hat-crown");

  // 设置饰品
  outfitManager.setOutfit("accessory", "accessory-glasses");

  // 移除背景
  outfitManager.setOutfit("background", null);

  // 查看当前装扮
  const currentOutfit = outfitManager.getOutfit();
  console.log("当前装扮:", currentOutfit);
}

// 示例：解锁装扮
export function exampleUnlockOutfit(): void {
  // 解锁巫师帽
  const success = outfitManager.unlockOutfit("hat-wizard");
  if (success) {
    console.log("巫师帽已解锁！");
    // 现在可以设置这个装扮
    outfitManager.setOutfit("hat", "hat-wizard");
  }
}

// 示例：获取装扮信息
export function exampleGetOutfitInfo(): void {
  // 获取所有已解锁的装扮
  const unlocked = outfitManager.getUnlockedOutfits();
  console.log("已解锁的装扮:", unlocked);

  // 获取帽子类别的所有装扮
  const hats = outfitManager.getOutfitsByCategory("hat");
  console.log("所有帽子:", hats);

  // 检查特定装扮是否已解锁
  const isWizardUnlocked = outfitManager.isOutfitUnlocked("hat-wizard");
  console.log("巫师帽是否已解锁:", isWizardUnlocked);
}