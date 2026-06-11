import { describe, expect, it } from "vitest";
import { getLive2DProfileUrl, live2dModelOptions } from "./appShared";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../../../public");

type ProfileJson = {
  id?: string;
  name?: string;
  modelUrl?: string;
  fit?: Record<string, unknown>;
  motions?: Record<string, unknown>;
  idleMotions?: unknown[];
  tapMotions?: unknown[];
  expressions?: Record<string, unknown>;
};

function loadProfileFile(profileUrl: string): ProfileJson {
  const filePath = path.join(PUBLIC_DIR, profileUrl);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProfileJson;
}

function modelFileExists(modelUrl: string): boolean {
  const filePath = path.join(PUBLIC_DIR, modelUrl);
  return fs.existsSync(filePath);
}

describe("live2d model switching", () => {
  const enabledModels = live2dModelOptions.filter((option) => option.enabled);

  it("resolves unique profile URLs for all enabled models", () => {
    const profileUrls = enabledModels.map((m) => getLive2DProfileUrl(m.value));
    const uniqueUrls = new Set(profileUrls);
    expect(uniqueUrls.size).toBe(profileUrls.length);
  });

  it("resolves unique model URLs for all enabled models", () => {
    const modelUrls = enabledModels.map((m) => {
      const profile = loadProfileFile(getLive2DProfileUrl(m.value));
      return profile.modelUrl;
    });
    const uniqueUrls = new Set(modelUrls.filter(Boolean));
    expect(uniqueUrls.size).toBe(modelUrls.filter(Boolean).length);
  });

  it("has valid modelUrl in every enabled profile pointing to an existing file", () => {
    for (const model of enabledModels) {
      const profile = loadProfileFile(getLive2DProfileUrl(model.value));
      expect(profile.modelUrl, `${model.value} profile missing modelUrl`).toBeDefined();
      expect(profile.modelUrl, `${model.value} profile modelUrl is empty`).not.toBe("");
      expect(
        modelFileExists(profile.modelUrl!),
        `${model.value} model file not found at ${profile.modelUrl}`,
      ).toBe(true);
    }
  });

  it("has valid profile files for every enabled model", () => {
    for (const model of enabledModels) {
      const profileUrl = getLive2DProfileUrl(model.value);
      const filePath = path.join(PUBLIC_DIR, profileUrl);
      expect(fs.existsSync(filePath), `profile file not found: ${profileUrl}`).toBe(true);

      const profile = loadProfileFile(profileUrl);
      expect(profile.id, `${model.value} profile missing id`).toBe(model.value);
      expect(profile.name, `${model.value} profile missing name`).toBeDefined();
    }
  });

  it("does not fall back to Mao model when switching between enabled models", () => {
    const maoModelUrl = "/live2d/sample/Mao.model3.json";
    const nonMaoModels = enabledModels.filter((m) => m.value !== "official-mao");

    for (const model of nonMaoModels) {
      const profile = loadProfileFile(getLive2DProfileUrl(model.value));
      expect(
        profile.modelUrl,
        `${model.value} should NOT use Mao model URL`,
      ).not.toBe(maoModelUrl);
    }
  });

  it("getLive2DProfileUrl returns the correct profile for each enabled model", () => {
    for (const model of enabledModels) {
      const profileUrl = getLive2DProfileUrl(model.value);
      expect(profileUrl).toBe(model.profileUrl);
      expect(profileUrl).toContain(model.value);
    }
  });
});
