import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { LiveCharacterPet } from "./LiveCharacterPet";

const CUBISM_CORE_URL = "/live2d/core/live2dcubismcore.min.js";
const DEFAULT_PROFILE_URL = "/live2d/profiles/official-mao.profile.json";
const DEFAULT_MODEL_URL = "/live2d/sample/Mao.model3.json";

let cubismCorePromise: Promise<void> | null = null;
let live2dPluginRegistered = false;
let cubismSDKConfigured = false;
const profilePromises = new Map<string, Promise<Live2DCharacterProfile>>();

type Live2DStatus = "loading" | "ready" | "fallback";

type Live2DMotion = {
  group: string;
  index?: number;
  priority?: number;
};

type Live2DFitProfile = {
  y?: number;
  targetWidth?: number;
  targetHeight?: number;
  compactTargetWidth?: number;
  compactTargetHeight?: number;
};

type Live2DCharacterProfile = {
  modelUrl?: string;
  fit?: Live2DFitProfile;
  motions?: Record<string, Live2DMotion>;
  idleMotions?: Live2DMotion[];
  tapMotions?: Live2DMotion[];
  expressions?: Record<string, number | string>;
};

type Live2DModelLike = {
  anchor?: { set: (x: number, y?: number) => void };
  position?: { set: (x: number, y?: number) => void };
  scale?: { set: (x: number, y?: number) => void };
  rotation?: number;
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
  motion?: (group: string, index?: number, priority?: number) => Promise<boolean>;
  expression?: (id?: number | string) => Promise<boolean>;
  focus?: (x: number, y: number, instant?: boolean) => void;
  internalModel?: {
    width?: number;
    height?: number;
    originalWidth?: number;
    originalHeight?: number;
    coreModel?: {
      setParameterValueById?: (id: unknown, value: number, weight?: number) => void;
    };
  };
  destroy?: (options?: unknown) => void;
};

type Live2DCoreModelLike = NonNullable<Live2DModelLike["internalModel"]>["coreModel"];

export interface Live2DCharacterPetProps {
  mode: string;
  emotion: string;
  reaction: string;
  compact?: boolean;
  mouseDelta?: { x: number; y: number };
  style?: CSSProperties;
  modelId?: string;
  modelUrl?: string;
  profileUrl?: string;
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    fetch(src)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load ${src}: ${response.status} ${response.statusText}`);
        return response.text();
      })
      .then((source) => {
        new Function("globalObject", `${source}\n;globalObject.Live2DCubismCore = Live2DCubismCore;`)(window);
        resolve();
      })
      .catch((error) => {
        console.error("[Live2D] Failed to load Cubism Core script:", error);
        reject(error);
      });
  });
}

function getErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? ` ${cause.message}` : "";
  return `${error.message}${causeMessage}`;
}

function hasCubismMemoryApi() {
  const core = (window as unknown as {
    Live2DCubismCore?: { Memory?: { initializeAmountOfMemory?: unknown } };
  }).Live2DCubismCore;
  return typeof core?.Memory?.initializeAmountOfMemory === "function";
}

function waitForCubismCoreApi() {
  return new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (hasCubismMemoryApi()) {
        resolve();
        return;
      }
      attempts += 1;
      if (attempts > 50) {
        reject(new Error("Cubism Core API did not become ready"));
        return;
      }
      window.setTimeout(check, 20);
    };
    check();
  });
}

function loadProfile(src: string): Promise<Live2DCharacterProfile> {
  if (!src) return Promise.resolve({});
  const existing = profilePromises.get(src);
  if (existing) return existing;

  const promise = fetch(src)
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load ${src}`);
      return response.json() as Promise<Live2DCharacterProfile>;
    })
    .catch((error) => {
      console.warn("[Live2D] Profile loading failed, will retry on next request.", error);
      profilePromises.delete(src);
      return {};
    });

  profilePromises.set(src, promise);
  return promise;
}

function ensureCubismCore() {
  if (typeof window === "undefined") return Promise.reject(new Error("Live2D requires a browser"));
  (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "checking-core";
  if ("Live2DCubismCore" in window) return Promise.resolve();
  cubismCorePromise ??= loadScript(CUBISM_CORE_URL).then(() => {
    (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "core-loaded";
    if (!("Live2DCubismCore" in window)) {
      throw new Error("Cubism Core did not attach to window");
    }
    return waitForCubismCoreApi();
  }).catch((error) => {
    cubismCorePromise = null;
    throw error;
  });
  return cubismCorePromise;
}

function getStateKeys(mode: string, emotion: string, reaction: string) {
  return [reaction, mode, emotion, "idle"].filter(Boolean);
}

function getMotionForState(mode: string, emotion: string, reaction: string, profile: Live2DCharacterProfile) {
  for (const key of getStateKeys(mode, emotion, reaction)) {
    const motion = profile.motions?.[key];
    if (motion) return motion;
  }
  return { group: "Idle", index: 0, priority: 1 };
}

function playMotion(model: Live2DModelLike | null, motion?: Live2DMotion) {
  if (!model || !motion) return;
  void model.motion?.(motion.group, motion.index, motion.priority).catch(() => undefined);
}

function pickMotion(motions?: Live2DMotion[]) {
  if (!motions?.length) return undefined;
  return motions[Math.floor(Math.random() * motions.length)];
}

function getExpressionForState(emotion: string, reaction: string, profile: Live2DCharacterProfile) {
  for (const key of getStateKeys("", emotion, reaction)) {
    const expression = profile.expressions?.[key];
    if (expression !== undefined) return expression;
  }
  return undefined;
}

function fitModel(
  model: Live2DModelLike,
  width: number,
  height: number,
  compact: boolean,
  fit?: Live2DFitProfile,
) {
  if (!model.position?.set || !model.scale?.set) return;

  model.position.set(width / 2, height * (fit?.y ?? 0.52));
  const modelWidth = Math.max(1, model.internalModel?.width ?? model.originalWidth ?? model.width ?? width);
  const modelHeight = Math.max(1, model.internalModel?.height ?? model.originalHeight ?? model.height ?? height);
  const targetWidth = width * (compact ? fit?.compactTargetWidth ?? 0.86 : fit?.targetWidth ?? 0.94);
  const targetHeight = height * (compact ? fit?.compactTargetHeight ?? 0.9 : fit?.targetHeight ?? 0.98);
  const scale = Math.min(targetWidth / modelWidth, targetHeight / modelHeight);
  model.scale.set(scale, scale);
}

export function Live2DCharacterPet({
  mode,
  emotion,
  reaction,
  compact = false,
  mouseDelta,
  style,
  modelId,
  modelUrl,
  profileUrl = DEFAULT_PROFILE_URL,
}: Live2DCharacterPetProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<Live2DModelLike | null>(null);
  const mouseDeltaRef = useRef({ x: 0, y: 0 });
  const appRef = useRef<any>(null);
  const tickerCallbackRef = useRef<((ticker: { deltaMS?: number }) => void) | null>(null);
  const idleTimerRef = useRef<number>(0);
  const lastMotionRef = useRef("");
  const lastExpressionRef = useRef("");
  const [status, setStatus] = useState<Live2DStatus>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [profile, setProfile] = useState<Live2DCharacterProfile>({});

  const fallbackStyle = useMemo<CSSProperties>(() => ({
    ...style,
    opacity: status === "fallback" ? 1 : 0,
  }), [status, style]);

  useEffect(() => {
    mouseDeltaRef.current = mouseDelta ?? { x: 0, y: 0 };
  }, [mouseDelta]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;

    async function initLive2D() {
      const host = hostRef.current;
      if (!host) return;

      let activeProfile: Live2DCharacterProfile = {};

      try {
        (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "init-start";
        activeProfile = await loadProfile(profileUrl);
        if (disposed) return;
        const activeModelUrl = modelUrl ?? activeProfile.modelUrl ?? DEFAULT_MODEL_URL;
        (window as unknown as { __pikoLive2DModelUrl?: string }).__pikoLive2DModelUrl = activeModelUrl;
        console.log(`[Live2D] profileUrl=${profileUrl} modelUrl=${activeModelUrl} profileHasModelUrl=${Boolean(activeProfile.modelUrl)}`);
        setProfile(activeProfile);
        await ensureCubismCore();
        if (disposed) return;
        (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "importing-engine";
        const { Application, extensions } = await import("pixi.js");
        const live2d = await import("untitled-pixi-live2d-engine/cubism");
        if (disposed) return;
        const { Live2DModel, Live2DPlugin, configureCubismSDK, cubismReady } = live2d;

        if (!live2dPluginRegistered) {
          extensions.add(Live2DPlugin);
          live2dPluginRegistered = true;
        }

        if (!cubismSDKConfigured) {
          configureCubismSDK({ memorySizeMB: 32 });
          cubismSDKConfigured = true;
        }
        await cubismReady();
        if (disposed) return;

        const app = new Application();
        (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "creating-pixi";
        await app.init({
          antialias: true,
          autoDensity: true,
          backgroundAlpha: 0,
          preference: "webgl",
          resolution: window.devicePixelRatio || 1,
        });

        if (disposed) {
          app.destroy(true, { children: true, texture: true });
          return;
        }

        while (host.firstChild) host.removeChild(host.firstChild);
        app.canvas.className = "live2d-character-canvas";
        app.canvas.style.width = "100%";
        app.canvas.style.height = "100%";
        host.appendChild(app.canvas);
        appRef.current = app;

        (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "loading-model";
        console.log(`[Live2D] loading model from ${activeModelUrl}`);
        const model = await Live2DModel.from(activeModelUrl, {
          autoFocus: false,
          autoHitTest: false,
          autoUpdate: true,
          ticker: app.ticker,
          textureOptions: { lod: "single-auto" },
        }) as Live2DModelLike;
        console.log(`[Live2D] model loaded successfully: ${activeModelUrl}`);
        (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "model-loaded";

        if (disposed) {
          model.destroy?.({ children: true, texture: true });
          app.destroy(true, { children: true, texture: true });
          return;
        }

        model.anchor?.set(0.5, 0.5);
        app.stage.addChild(model as never);
        modelRef.current = model;

        let phase = 0;
        const driveAttention = (ticker: { deltaMS?: number }) => {
          phase += (ticker.deltaMS ?? 16.67) / 1000;
          const pointer = mouseDeltaRef.current;
          const idleX = Math.sin(phase * 0.85) * 0.08;
          const idleY = Math.sin(phase * 0.67 + 1.2) * 0.06;
          const x = pointer.x + idleX;
          const y = pointer.y + idleY;
          const coreModel: Live2DCoreModelLike = model.internalModel?.coreModel;
          const width = Math.max(1, app.screen.width);
          const height = Math.max(1, app.screen.height);
          const modelWidth = Math.max(1, model.internalModel?.width ?? model.originalWidth ?? model.width ?? width);
          const modelHeight = Math.max(1, model.internalModel?.height ?? model.originalHeight ?? model.height ?? height);
          const fit = activeProfile.fit;
          const targetWidth = width * (compact ? fit?.compactTargetWidth ?? 0.86 : fit?.targetWidth ?? 0.94);
          const targetHeight = height * (compact ? fit?.compactTargetHeight ?? 0.9 : fit?.targetHeight ?? 0.98);
          const baseScale = Math.min(targetWidth / modelWidth, targetHeight / modelHeight);
          const breathScale = 1 + Math.sin(phase * 2.1) * 0.018;

          model.focus?.(
            app.screen.width / 2 + x * app.screen.width * 0.42,
            app.screen.height / 2 + y * app.screen.height * 0.36,
          );
          model.position?.set(
            width / 2 + pointer.x * width * 0.03,
            height * (fit?.y ?? 0.52) + Math.sin(phase * 1.15) * height * 0.012 + pointer.y * height * 0.018,
          );
          model.scale?.set(baseScale * breathScale, baseScale * breathScale);
          model.rotation = pointer.x * 0.1 + Math.sin(phase * 0.9) * 0.018;
          coreModel?.setParameterValueById?.("ParamEyeBallX", x * 1.1, 0.65);
          coreModel?.setParameterValueById?.("ParamEyeBallY", -y * 0.95, 0.65);
          coreModel?.setParameterValueById?.("ParamAngleX", x * 28, 0.35);
          coreModel?.setParameterValueById?.("ParamAngleY", -y * 20, 0.35);
          coreModel?.setParameterValueById?.("ParamAngleZ", -x * 8, 0.2);
          coreModel?.setParameterValueById?.("ParamBodyAngleX", x * 9, 0.18);
          coreModel?.setParameterValueById?.("ParamBodyAngleY", -y * 6, 0.18);
          coreModel?.setParameterValueById?.("ParamBreath", 0.5 + Math.sin(phase * 2.1) * 0.45, 0.22);
        };
        tickerCallbackRef.current = driveAttention;
        app.ticker.add(driveAttention);

        const resize = () => {
          const rect = host.getBoundingClientRect();
          const width = Math.max(1, rect.width);
          const height = Math.max(1, rect.height);
          app.renderer.resize(width, height);
          fitModel(model, width, height, compact, activeProfile.fit);
        };

        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);
        resize();
        playMotion(model, activeProfile.motions?.idle);
        idleTimerRef.current = window.setInterval(() => {
          if (disposed || !modelRef.current) return;
          playMotion(modelRef.current, pickMotion(activeProfile.idleMotions) ?? activeProfile.motions?.idle);
        }, 9000);
        setStatus("ready");
        (window as unknown as { __pikoLive2DStatus?: string }).__pikoLive2DStatus = "ready";
      } catch (error) {
        const message = getErrorMessage(error);
        (window as unknown as {
          __pikoLive2DStatus?: string;
          __pikoLive2DError?: string;
          __pikoLive2DModelUrl?: string;
        }).__pikoLive2DStatus = "fallback";
        (window as unknown as {
          __pikoLive2DStatus?: string;
          __pikoLive2DError?: string;
          __pikoLive2DModelUrl?: string;
        }).__pikoLive2DError = `[modelUrl=${modelUrl ?? activeProfile?.modelUrl ?? DEFAULT_MODEL_URL}] ${message}`;
        console.warn("[Live2D] Initialization failed, falling back to atlas renderer.", {
          profileUrl,
          modelUrl: modelUrl ?? activeProfile?.modelUrl ?? DEFAULT_MODEL_URL,
          error,
        });
        if (!disposed) {
          setErrorMessage(message);
          setStatus("fallback");
        }
      }
    }

    setStatus("loading");
    setErrorMessage("");
    void initLive2D();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (tickerCallbackRef.current) {
        appRef.current?.ticker?.remove?.(tickerCallbackRef.current);
        tickerCallbackRef.current = null;
      }
      if (idleTimerRef.current) {
        window.clearInterval(idleTimerRef.current);
        idleTimerRef.current = 0;
      }
      modelRef.current?.destroy?.({ children: true, texture: true });
      modelRef.current = null;
      appRef.current?.destroy(true, { children: true, texture: true });
      appRef.current = null;
    };
  }, [compact, modelUrl, profileUrl]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || status !== "ready") return;

    const { group, index, priority } = getMotionForState(mode, emotion, reaction, profile);
    const motionKey = `${group}:${index}:${priority}`;
    if (motionKey !== lastMotionRef.current) {
      lastMotionRef.current = motionKey;
      void model.motion?.(group, index, priority).catch(() => undefined);
    }

    const expression = getExpressionForState(emotion, reaction, profile);
    const expressionKey = expression === undefined ? "" : String(expression);
    if (expressionKey !== lastExpressionRef.current) {
      lastExpressionRef.current = expressionKey;
      void model.expression?.(expression).catch(() => undefined);
    }
  }, [emotion, mode, profile, reaction, status]);

  return (
    <span
      className="live2d-character-pet"
      data-live2d-model-id={modelId}
      data-live2d-status={status}
      data-live2d-error={errorMessage}
      style={style}
      onPointerDown={() => {
        if (status === "ready") {
          playMotion(modelRef.current, pickMotion(profile.tapMotions) ?? profile.motions?.greet);
        }
      }}
    >
      <span ref={hostRef} className="live2d-character-host" aria-hidden="true" />
      {status !== "ready" ? (
        <LiveCharacterPet
          mode={mode}
          emotion={emotion}
          reaction={reaction}
          compact={compact}
          mouseDelta={mouseDelta}
          style={fallbackStyle}
        />
      ) : null}
    </span>
  );
}
