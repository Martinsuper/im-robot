import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 400, height: 700 } });

const styleKey = "piko-pet-visual-style";
const imageKey = "piko-custom-pet-image-path";

test("默认经典形象与选择器一致，切换同步到精灵窗口并在刷新后保留", async ({
  page,
  context,
}) => {
  await page.goto("/?view=panel");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator("#settings-group-companion > summary").click();
  const selector = page.getByRole("combobox", {
    name: "精灵形象",
    exact: true,
  });
  await expect(selector).toHaveValue("classic");
  await expect(selector.locator('option[value="character"]')).toHaveCount(0);
  await expect(selector.locator("option:checked")).toHaveText("经典 Piko");
  const pet = await context.newPage();
  await pet.goto("/?view=pet");
  await expect(pet.locator(".pet-sprite-frame--classic")).toBeVisible();

  for (const style of ["lumi", "classic", "lumi", "classic", "lumi"] as const) {
    await selector.selectOption(style);
    await expect(selector).toHaveValue(style);
    await expect(pet.locator(`.pet--${style}`)).toBeVisible();
    await expect(
      pet.locator(
        `.pet-sprite-frame--${style === "lumi" ? "robot-cat" : "classic"}`,
      ),
    ).toBeVisible();
  }
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator("#settings-group-companion > summary").click();
  await expect(selector).toHaveValue("lumi");
  await pet.reload();
  await expect(pet.locator(".pet-sprite-frame--robot-cat")).toBeVisible();
  await page.screenshot({ path: "test-results/pet-appearance-settings.png" });
});

for (const stored of ["classic", "custom", "obsolete", "character"]) {
  test(`已有 ${stored} 值能恢复为可见的经典选项`, async ({ page }) => {
    await page.addInitScript(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: styleKey, value: stored },
    );
    await page.goto("/?view=panel");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator("#settings-group-companion > summary").click();
    const selector = page.getByRole("combobox", {
      name: "精灵形象",
      exact: true,
    });
    await expect(selector).toHaveValue("classic");
    await expect(selector.locator('option[value="character"]')).toHaveCount(0);
    await expect(selector.locator("option:checked")).toHaveText("经典 Piko");
    expect(
      await page.evaluate((key) => localStorage.getItem(key), styleKey),
    ).toBe("classic");
  });
}

test("删除当前自定义图片后，设置和精灵都回到经典形象", async ({
  page,
  context,
}) => {
  await page.addInitScript(
    ({ styleKey, imageKey }) => {
      localStorage.setItem(styleKey, "custom");
      localStorage.setItem(imageKey, "/test-pet.png");
    },
    { styleKey, imageKey },
  );
  await page.goto("/?view=panel");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator("#settings-group-companion > summary").click();
  const selector = page.getByRole("combobox", {
    name: "精灵形象",
    exact: true,
  });
  await expect(selector).toHaveValue("custom");
  const pet = await context.newPage();
  await pet.goto("/?view=pet");
  await expect(pet.locator(".pet-sprite-frame--custom")).toBeVisible();
  await page.getByRole("button", { name: "清除", exact: true }).click();
  await expect(selector).toHaveValue("classic");
  await expect(selector.locator('option[value="character"]')).toHaveCount(0);
  await expect(selector.locator('option[value="custom"]')).toHaveCount(0);
  await expect(pet.locator(".pet-sprite-frame--classic")).toBeVisible();
});
