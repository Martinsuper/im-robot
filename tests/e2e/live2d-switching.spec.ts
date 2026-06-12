import { expect, test } from "@playwright/test";

test("official model switch mounts a single Live2D canvas without fallback overlap", async ({ page }) => {
  await page.goto("/?view=pet");
  await page.evaluate(() => {
    localStorage.setItem("piko-live2d-official-model-migrated", "3");
    localStorage.setItem("piko-pet-visual-style", "lumi");
    localStorage.setItem("piko-live2d-model-id", "official-hiyori");
  });
  await page.reload();

  await expect(page.locator(".robot-cat-sprite")).toHaveCount(1);
  await page.getByRole("button", { name: "官方" }).click();

  const live2dPet = page.locator(".live2d-character-pet");
  await expect(live2dPet).toHaveAttribute("data-live2d-model-id", "official-hiyori");
  await expect(live2dPet).toHaveAttribute("data-live2d-status", "ready", { timeout: 15000 });
  await expect(page.locator(".live2d-character-canvas")).toHaveCount(1);
  await expect(page.locator(".live2d-character-pet .live-character-pet")).toHaveCount(0);
  await expect(page.locator(".robot-cat-sprite")).toHaveCount(0);

  await page.getByRole("button", { name: "换模型" }).click();
  await expect(live2dPet).toHaveAttribute("data-live2d-model-id", "official-wanko");
  await expect(live2dPet).toHaveAttribute("data-live2d-status", "ready", { timeout: 15000 });
  await expect(page.locator(".live2d-character-canvas")).toHaveCount(1);
  await expect(page.locator(".live2d-character-pet .live-character-pet")).toHaveCount(0);
  await expect(page.locator(".robot-cat-sprite")).toHaveCount(0);
});
