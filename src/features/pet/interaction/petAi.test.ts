import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generatePetCompanionResponse,
  resolvePetBehaviorProfile,
  resolvePetBehaviorPriority,
  resolvePetIdleMotionStyle,
  type PetCompanionGenerationInput,
} from "./petAi";
import type { PersonalityDimensions } from "../personality";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  runtime: { isTauriRuntime: true },
}));

vi.mock("../../app/appRuntime", () => ({
  get isTauriRuntime() {
    return mocks.runtime.isTauriRuntime;
  },
  runCommand: mocks.runCommand,
}));

const basePersonality: PersonalityDimensions = { energy: 0.5, humor: 0.2, curiosity: 0.8 };

function baseInput(): PetCompanionGenerationInput {
  return {
    mode: "dialogue",
    scene: "chat",
    bondTier: "warm",
    interactionType: "chat",
    personality: basePersonality,
    personalitySummary: "summary-base",
    context: "测试上下文",
  };
}

type ResolverInput = Parameters<typeof resolvePetIdleMotionStyle>[0];

function resolverInput(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    bondTier: "new",
    personality: { energy: 0.1, humor: 0.2, curiosity: 0.3 },
    personalitySummary: "summary-default",
    ...overrides,
  };
}

describe("generatePetCompanionResponse", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.runCommand.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("非 Tauri 运行时直接返回 null，不触发命令", async () => {
    mocks.runtime.isTauriRuntime = false;
    try {
      const result = await generatePetCompanionResponse(baseInput());
      expect(result).toBeNull();
      expect(mocks.runCommand).not.toHaveBeenCalled();
    } finally {
      mocks.runtime.isTauriRuntime = true;
    }
  });

  it("正常结果透传：message 去首尾空白，合法字段保留", async () => {
    mocks.runCommand.mockResolvedValueOnce({
      message: "  你好呀  ",
      motionStyle: "lively",
      behaviorProfile: "curious",
      behaviorPriority: ["calm", "playful"],
    });

    const result = await generatePetCompanionResponse(baseInput());

    expect(result).toEqual({
      message: "你好呀",
      motionStyle: "lively",
      behaviorProfile: "curious",
      behaviorPriority: ["calm", "playful"],
    });
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "generate_pet_companion_response",
      expect.objectContaining({ mode: "dialogue", scene: "chat", bondTier: "warm" }),
      undefined,
    );
  });

  it("类型不匹配的字段全部归一化为 undefined", async () => {
    mocks.runCommand.mockResolvedValueOnce({
      message: 42,
      motionStyle: "crazy",
      behaviorProfile: "angry",
      behaviorPriority: "calm",
    });

    const result = await generatePetCompanionResponse(baseInput());

    expect(result).toStrictEqual({
      message: undefined,
      motionStyle: undefined,
      behaviorProfile: undefined,
      behaviorPriority: undefined,
    });
  });

  it("behaviorPriority 过滤非法标签后返回合法子集", async () => {
    mocks.runCommand.mockResolvedValueOnce({
      behaviorPriority: ["calm", "angry", "neutral", 7, null],
    });

    const result = await generatePetCompanionResponse(baseInput());

    expect(result?.behaviorPriority).toEqual(["calm", "neutral"]);
  });

  it("后端返回 null 时返回 null", async () => {
    mocks.runCommand.mockResolvedValueOnce(null);

    const result = await generatePetCompanionResponse(baseInput());

    expect(result).toBeNull();
  });

  it("后端返回空对象时字段缺省为 undefined", async () => {
    mocks.runCommand.mockResolvedValueOnce({});

    const result = await generatePetCompanionResponse(baseInput());

    expect(result).toStrictEqual({
      message: undefined,
      motionStyle: undefined,
      behaviorProfile: undefined,
      behaviorPriority: undefined,
    });
  });

  it("空白 message 归一化为空字符串", async () => {
    mocks.runCommand.mockResolvedValueOnce({ message: "   " });

    const result = await generatePetCompanionResponse(baseInput());

    expect(result?.message).toBe("");
  });

  it("命令失败时返回 null 并输出告警", async () => {
    mocks.runCommand.mockRejectedValueOnce(new Error("backend boom"));

    const result = await generatePetCompanionResponse(baseInput());

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("resolvePetIdleMotionStyle", () => {
  beforeEach(() => {
    mocks.runCommand.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("相同输入复用缓存：只调用一次命令", async () => {
    mocks.runCommand.mockResolvedValue({ motionStyle: "soft" });
    const input = resolverInput({ bondTier: "warm", personalitySummary: "idle-cache-hit" });

    await expect(resolvePetIdleMotionStyle(input)).resolves.toBe("soft");
    await expect(resolvePetIdleMotionStyle(input)).resolves.toBe("soft");

    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "generate_pet_companion_response",
      expect.objectContaining({ mode: "idleProfile", scene: "idle", bondTier: "warm" }),
      undefined,
    );
  });

  it("不同输入（bondTier / 人格维度 / 摘要）产生不同缓存键", async () => {
    mocks.runCommand.mockResolvedValue({ motionStyle: "balanced" });

    await resolvePetIdleMotionStyle(resolverInput({ bondTier: "new", personalitySummary: "idle-key-a" }));
    await resolvePetIdleMotionStyle(
      resolverInput({ bondTier: "close", personality: { energy: 0.9, humor: -0.4, curiosity: 0.1 }, personalitySummary: "idle-key-a" }),
    );
    await resolvePetIdleMotionStyle(resolverInput({ bondTier: "close", personalitySummary: "idle-key-c" }));

    expect(mocks.runCommand).toHaveBeenCalledTimes(3);
  });

  it("响应缺少 motionStyle 时返回 null 且缓存被清除（下次重试）", async () => {
    mocks.runCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ motionStyle: "lively" });
    const input = resolverInput({ bondTier: "trusted", personalitySummary: "idle-missing" });

    await expect(resolvePetIdleMotionStyle(input)).resolves.toBeNull();
    await expect(resolvePetIdleMotionStyle(input)).resolves.toBe("lively");
    expect(mocks.runCommand).toHaveBeenCalledTimes(2);
  });

  it("命令失败时返回 null 且缓存被清除（下次重试成功）", async () => {
    mocks.runCommand
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ motionStyle: "soft" });
    const input = resolverInput({ bondTier: "close", personalitySummary: "idle-retry" });

    await expect(resolvePetIdleMotionStyle(input)).resolves.toBeNull();
    await expect(resolvePetIdleMotionStyle(input)).resolves.toBe("soft");
    expect(mocks.runCommand).toHaveBeenCalledTimes(2);
  });

  it("挂起期间并发调用共享同一个 pending promise", async () => {
    let release: ((value: { motionStyle: "lively" }) => void) | undefined;
    mocks.runCommand.mockImplementationOnce(
      () =>
        new Promise<{ motionStyle: "lively" }>((resolve) => {
          release = resolve;
        }),
    );
    const input = resolverInput({ bondTier: "warm", personalitySummary: "idle-concurrent" });

    const first = resolvePetIdleMotionStyle(input);
    const second = resolvePetIdleMotionStyle(input);

    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    release?.({ motionStyle: "lively" });
    await expect(first).resolves.toBe("lively");
    await expect(second).resolves.toBe("lively");
  });
});

describe("resolvePetBehaviorProfile", () => {
  beforeEach(() => {
    mocks.runCommand.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("合法 profile 返回并写入缓存", async () => {
    mocks.runCommand.mockResolvedValue({ behaviorProfile: "focused" });
    const input = resolverInput({ bondTier: "trusted", personalitySummary: "profile-hit" });

    await expect(resolvePetBehaviorProfile(input)).resolves.toBe("focused");
    await expect(resolvePetBehaviorProfile(input)).resolves.toBe("focused");
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "generate_pet_companion_response",
      expect.objectContaining({ mode: "behaviorProfile", scene: "behavior" }),
      undefined,
    );
  });

  it("非法 profile 返回 null 且缓存被清除（下次重试命中新值）", async () => {
    mocks.runCommand
      .mockResolvedValueOnce({ behaviorProfile: "grumpy" })
      .mockResolvedValueOnce({ behaviorProfile: "calm" });
    const input = resolverInput({ bondTier: "warm", personalitySummary: "profile-invalid" });

    await expect(resolvePetBehaviorProfile(input)).resolves.toBeNull();
    await expect(resolvePetBehaviorProfile(input)).resolves.toBe("calm");
    expect(mocks.runCommand).toHaveBeenCalledTimes(2);
  });
});

describe("resolvePetBehaviorPriority", () => {
  beforeEach(() => {
    mocks.runCommand.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("过滤非法标签后返回合法子集并写入缓存", async () => {
    mocks.runCommand.mockResolvedValue({
      behaviorPriority: ["curious", "unknown-tag", "focused", 3],
    });
    const input = resolverInput({ bondTier: "close", personalitySummary: "priority-filter" });

    await expect(resolvePetBehaviorPriority(input)).resolves.toEqual(["curious", "focused"]);
    await expect(resolvePetBehaviorPriority(input)).resolves.toEqual(["curious", "focused"]);
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "generate_pet_companion_response",
      expect.objectContaining({ mode: "behaviorPriority", scene: "behavior" }),
      undefined,
    );
  });

  it("全部标签非法时返回 null 且缓存被清除（下次重试）", async () => {
    mocks.runCommand
      .mockResolvedValueOnce({ behaviorPriority: ["nope", "nada"] })
      .mockResolvedValueOnce({ behaviorPriority: ["calm"] });
    const input = resolverInput({ bondTier: "new", personalitySummary: "priority-invalid" });

    await expect(resolvePetBehaviorPriority(input)).resolves.toBeNull();
    await expect(resolvePetBehaviorPriority(input)).resolves.toEqual(["calm"]);
    expect(mocks.runCommand).toHaveBeenCalledTimes(2);
  });

  it("响应缺少 behaviorPriority 时返回 null 并清除缓存", async () => {
    mocks.runCommand
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ behaviorPriority: ["playful"] });
    const input = resolverInput({ bondTier: "trusted", personalitySummary: "priority-missing" });

    await expect(resolvePetBehaviorPriority(input)).resolves.toBeNull();
    await expect(resolvePetBehaviorPriority(input)).resolves.toEqual(["playful"]);
    expect(mocks.runCommand).toHaveBeenCalledTimes(2);
  });
});
