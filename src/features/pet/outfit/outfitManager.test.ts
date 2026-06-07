import { describe, expect, it, vi } from "vitest";
import { OutfitManager } from "./OutfitManager";
import type { OutfitCatalog } from "./outfitTypes";

describe("OutfitManager", () => {
  const createTestCatalog = (): OutfitCatalog => ({
    hats: [
      {
        id: "hat-1",
        name: "Test Hat",
        category: "hat",
        description: "A test hat",
        unlockState: "unlocked",
        thumbnailPath: "/thumbnails/hat-1.png",
        assetPath: "/assets/hat-1.png",
      },
      {
        id: "hat-2",
        name: "Locked Hat",
        category: "hat",
        description: "A locked hat",
        unlockState: "locked",
        thumbnailPath: "/thumbnails/hat-2.png",
        assetPath: "/assets/hat-2.png",
      },
    ],
    accessories: [],
    backgrounds: [],
    effects: [],
  });

  it("initializes with default state", () => {
    const manager = new OutfitManager();
    const state = manager.getOutfit();

    expect(state.hat).toBeNull();
    expect(state.accessory).toBeNull();
    expect(state.background).toBeNull();
    expect(state.effect).toBeNull();
  });

  it("sets and gets outfit items", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    manager.setOutfit("hat", "hat-1");
    expect(manager.getOutfit().hat).toBe("hat-1");
  });

  it("does not set locked items", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    manager.setOutfit("hat", "hat-2");
    expect(manager.getOutfit().hat).toBeNull();
  });

  it("clears outfit by setting null", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    manager.setOutfit("hat", "hat-1");
    expect(manager.getOutfit().hat).toBe("hat-1");

    manager.setOutfit("hat", null);
    expect(manager.getOutfit().hat).toBeNull();
  });

  it("unlocks outfit items", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    expect(manager.isOutfitUnlocked("hat-2")).toBe(false);
    const result = manager.unlockOutfit("hat-2");
    expect(result).toBe(true);
    expect(manager.isOutfitUnlocked("hat-2")).toBe(true);
  });

  it("returns false when unlocking non-existent items", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    const result = manager.unlockOutfit("non-existent");
    expect(result).toBe(false);
  });

  it("gets outfit item by category", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    manager.setOutfit("hat", "hat-1");
    const item = manager.getOutfitItem("hat");
    expect(item).not.toBeNull();
    expect(item?.id).toBe("hat-1");
  });

  it("gets all unlocked outfits", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    const unlocked = manager.getUnlockedOutfits();
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].id).toBe("hat-1");
  });

  it("gets outfits by category", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    const hats = manager.getOutfitsByCategory("hat");
    expect(hats).toHaveLength(2);
  });

  it("notifies callbacks on outfit change", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    const callback = vi.fn();
    manager.onChange(callback);

    manager.setOutfit("hat", "hat-1");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ hat: "hat-1" }),
    );
  });

  it("removes callback on unsubscribe", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    const callback = vi.fn();
    const unsubscribe = manager.onChange(callback);

    manager.setOutfit("hat", "hat-1");
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.setOutfit("hat", null);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("resets to default state", () => {
    const manager = new OutfitManager();
    manager.loadCatalog(createTestCatalog());

    manager.setOutfit("hat", "hat-1");
    expect(manager.getOutfit().hat).toBe("hat-1");

    manager.reset();
    expect(manager.getOutfit().hat).toBeNull();
  });
});
