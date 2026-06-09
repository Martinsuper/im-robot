import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

type AtlasPose =
  | "front"
  | "front_three_quarter"
  | "side"
  | "back"
  | "happy"
  | "curious"
  | "sleepy"
  | "playful"
  | "focused"
  | "celebrate";

type PoseBox = { x: number; y: number; w: number; h: number };

type PoseClipFrame = {
  pose: AtlasPose;
  emphasis?: number;
  offsetX?: number;
  offsetY?: number;
  rotate?: number;
  scale?: number;
};

type PoseClip = {
  duration: number;
  loop: boolean;
  frames: PoseClipFrame[];
};

const SHEET_URL = "/pets/piko-character-sheet.png";

const POSE_BOXES: Record<AtlasPose, PoseBox> = {
  front: { x: 109, y: 26, w: 280, h: 387 },
  front_three_quarter: { x: 461, y: 25, w: 278, h: 387 },
  side: { x: 785, y: 29, w: 275, h: 384 },
  back: { x: 1120, y: 32, w: 251, h: 383 },
  happy: { x: 51, y: 442, w: 255, h: 293 },
  curious: { x: 348, y: 438, w: 245, h: 308 },
  sleepy: { x: 606, y: 519, w: 292, h: 213 },
  playful: { x: 902, y: 448, w: 296, h: 293 },
  focused: { x: 1215, y: 458, w: 281, h: 285 },
  celebrate: { x: 606, y: 742, w: 260, h: 266 },
};

const POSE_TRANSFORMS: Record<AtlasPose, { scale: number; offsetX: number; offsetY: number; rotate: number }> = {
  front: { scale: 1, offsetX: 0, offsetY: 0, rotate: 0 },
  front_three_quarter: { scale: 1.01, offsetX: 0, offsetY: -2, rotate: 0.4 },
  side: { scale: 1.01, offsetX: 1, offsetY: -2, rotate: 0.8 },
  back: { scale: 1, offsetX: 0, offsetY: 0, rotate: 0.2 },
  happy: { scale: 1.01, offsetX: 0, offsetY: -2, rotate: 0 },
  curious: { scale: 1.01, offsetX: 0, offsetY: -1, rotate: -0.4 },
  sleepy: { scale: 0.99, offsetX: 0, offsetY: 3, rotate: 0 },
  playful: { scale: 1.02, offsetX: 0, offsetY: -1, rotate: 0.3 },
  focused: { scale: 1.01, offsetX: 0, offsetY: -1, rotate: 0 },
  celebrate: { scale: 1.03, offsetX: 0, offsetY: -4, rotate: 0 },
};

const POSE_CLIPS: Record<string, PoseClip> = {
  idle: {
    duration: 3400,
    loop: true,
    frames: [
      { pose: "front", emphasis: 0.1 },
      { pose: "front_three_quarter", emphasis: 0.34, offsetX: -1, offsetY: -1, rotate: -0.6 },
      { pose: "front", emphasis: 0.12 },
      { pose: "front_three_quarter", emphasis: 0.3, offsetX: 1, offsetY: -1, rotate: 0.6 },
      { pose: "front", emphasis: 0.1 },
    ],
  },
  happy: {
    duration: 2400,
    loop: true,
    frames: [
      { pose: "front", emphasis: 0.12 },
      { pose: "front_three_quarter", emphasis: 0.28, offsetY: -1, rotate: -0.6 },
      { pose: "happy", emphasis: 0.68, offsetY: -2, scale: 1.02 },
      { pose: "front_three_quarter", emphasis: 0.3, offsetY: -1, rotate: 0.5 },
      { pose: "front", emphasis: 0.12 },
    ],
  },
  curious: {
    duration: 2300,
    loop: true,
    frames: [
      { pose: "front", emphasis: 0.12 },
      { pose: "front_three_quarter", emphasis: 0.24, offsetY: -1, rotate: -0.4 },
      { pose: "curious", emphasis: 0.7, offsetY: -1, rotate: -0.5 },
      { pose: "front_three_quarter", emphasis: 0.28, offsetY: -1, rotate: 0.4 },
      { pose: "front", emphasis: 0.12 },
    ],
  },
  sleepy: {
    duration: 3800,
    loop: true,
    frames: [
      { pose: "front", emphasis: 0.12 },
      { pose: "front_three_quarter", emphasis: 0.18, offsetY: 1, rotate: -0.2 },
      { pose: "sleepy", emphasis: 0.72, offsetY: 4, scale: 0.99 },
      { pose: "front_three_quarter", emphasis: 0.18, offsetY: 1, rotate: 0.2 },
      { pose: "front", emphasis: 0.12 },
    ],
  },
  playful: {
    duration: 2100,
    loop: true,
    frames: [
      { pose: "front", emphasis: 0.12 },
      { pose: "front_three_quarter", emphasis: 0.24, offsetY: -1, rotate: -0.8 },
      { pose: "playful", emphasis: 0.72, offsetY: -2, scale: 1.03 },
      { pose: "front_three_quarter", emphasis: 0.24, offsetY: -1, rotate: 0.8 },
      { pose: "front", emphasis: 0.12 },
    ],
  },
  focused: {
    duration: 2800,
    loop: true,
    frames: [
      { pose: "front_three_quarter", emphasis: 0.16, offsetY: -1, rotate: -0.2 },
      { pose: "focused", emphasis: 0.66, offsetY: -1, scale: 1.02 },
      { pose: "front_three_quarter", emphasis: 0.18, offsetY: -1, rotate: 0.2 },
      { pose: "front", emphasis: 0.1 },
    ],
  },
  celebrate: {
    duration: 1800,
    loop: true,
    frames: [
      { pose: "front", emphasis: 0.1 },
      { pose: "celebrate", emphasis: 0.7, offsetY: -4, scale: 1.04, rotate: -0.3 },
      { pose: "happy", emphasis: 0.45, offsetY: -2, scale: 1.02, rotate: 0.2 },
      { pose: "front", emphasis: 0.12 },
    ],
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(t: number) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function getActionTheme(mode: string, emotion: string, reaction: string): keyof typeof POSE_CLIPS {
  if (reaction === "celebrate" || mode === "success") return "celebrate";
  if (reaction === "greet" || emotion === "happy") return "happy";
  if (mode === "resting" || emotion === "sleepy") return "sleepy";
  if (mode === "error" || emotion === "worried") return "focused";
  if (mode === "listening" || emotion === "surprised" || emotion === "thoughtful") return "curious";
  if (mode === "thinking" || mode === "working" || mode === "confirming") return "focused";
  if (emotion === "playful" || reaction === "idle_fidget") return "playful";
  if (emotion === "curious") return "curious";
  return "idle";
}

function resolveFramePair(clip: PoseClip, progress: number) {
  const frames = clip.frames;
  if (frames.length === 1) {
    return { from: frames[0], to: frames[0], mix: 0 };
  }

  const steps = clip.loop ? frames.length - 1 : frames.length - 1;
  const cycle = clip.loop ? 2 * steps : steps;
  const scaled = clamp(progress, 0, 1) * cycle;
  const segment = Math.min(Math.floor(scaled), cycle - 1);
  const local = scaled - segment;

  if (!clip.loop) {
    const fromIndex = Math.min(segment, frames.length - 2);
    const toIndex = fromIndex + 1;
    return { from: frames[fromIndex], to: frames[toIndex], mix: smoothstep(local) };
  }

  if (segment < steps) {
    const fromIndex = segment;
    const toIndex = segment + 1;
    return { from: frames[fromIndex], to: frames[toIndex], mix: smoothstep(local) };
  }

  const reverseIndex = cycle - segment;
  const fromIndex = Math.max(0, reverseIndex - 1);
  const toIndex = reverseIndex;
  return { from: frames[fromIndex], to: frames[toIndex], mix: smoothstep(local) };
}

function buildCutoutCanvas(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.drawImage(image, 0, 0);
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const isBackground = (i: number) => {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    return r > 246 && g > 246 && b > 246;
  };

  const enqueue = (i: number) => {
    if (visited[i]) return;
    visited[i] = 1;
    queue[tail++] = i;
  };

  for (let x = 0; x < width; x += 1) {
    const top = x;
    const bottom = (height - 1) * width + x;
    if (isBackground(top)) enqueue(top);
    if (isBackground(bottom)) enqueue(bottom);
  }
  for (let y = 0; y < height; y += 1) {
    const left = y * width;
    const right = y * width + (width - 1);
    if (isBackground(left)) enqueue(left);
    if (isBackground(right)) enqueue(right);
  }

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i / width) | 0;
    const idx = i * 4;
    data[idx + 3] = 0;

    if (x > 0) {
      const n = i - 1;
      if (!visited[n] && isBackground(n)) enqueue(n);
    }
    if (x < width - 1) {
      const n = i + 1;
      if (!visited[n] && isBackground(n)) enqueue(n);
    }
    if (y > 0) {
      const n = i - width;
      if (!visited[n] && isBackground(n)) enqueue(n);
    }
    if (y < height - 1) {
      const n = i + width;
      if (!visited[n] && isBackground(n)) enqueue(n);
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export interface LiveCharacterPetProps {
  mode: string;
  emotion: string;
  reaction: string;
  compact?: boolean;
  mouseDelta?: { x: number; y: number };
  style?: CSSProperties;
}

export function LiveCharacterPet({
  mode,
  emotion,
  reaction,
  compact = false,
  mouseDelta,
  style,
}: LiveCharacterPetProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<CanvasImageSource | null>(null);
  const propsRef = useRef({ mode, emotion, reaction, compact, mouseDelta });
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const themeStateRef = useRef<{ theme: keyof typeof POSE_CLIPS; previous: keyof typeof POSE_CLIPS; startedAt: number }>({
    theme: "idle",
    previous: "idle",
    startedAt: performance.now(),
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    propsRef.current = { mode, emotion, reaction, compact, mouseDelta };
  }, [mode, emotion, reaction, compact, mouseDelta]);

  useEffect(() => {
    let alive = true;
    const image = new Image();
    image.decoding = "async";
    image.src = SHEET_URL;
    image.onload = () => {
      if (!alive) return;
      try {
        imageRef.current = buildCutoutCanvas(image);
      } catch {
        imageRef.current = image;
      }
      setReady(true);
    };
    image.onerror = () => {
      if (!alive) return;
      setReady(false);
    };

    return () => {
      alive = false;
      imageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const nextTheme = getActionTheme(mode, emotion, reaction);
    const currentTheme = themeStateRef.current.theme;
    if (nextTheme !== currentTheme) {
      themeStateRef.current = {
        theme: nextTheme,
        previous: currentTheme,
        startedAt: performance.now(),
      };
    }
  }, [mode, emotion, reaction]);

  const canvasStyle = useMemo<CSSProperties>(
    () => ({
      ...style,
      imageRendering: "auto",
    }),
    [style]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 1;
    let height = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    resize();

    const drawPose = (
      pose: AtlasPose,
      alpha: number,
      time: number,
      baseX: number,
      baseY: number,
      globalScale: number,
      globalRotate: number,
      widthPx: number,
      heightPx: number
    ) => {
      const image = imageRef.current;
      if (!image || alpha <= 0) return;

      const source = POSE_BOXES[pose];
      const poseTransform = POSE_TRANSFORMS[pose];
      const sourceRatio = source.w / source.h;
      const poseScale = poseTransform.scale;
      const fitScale = 0.9;
      let renderW = Math.min(widthPx * globalScale, heightPx * sourceRatio * globalScale) * fitScale * poseScale;
      let renderH = renderW / sourceRatio;

      const bob = Math.sin(time * (pose === "sleepy" ? 0.001 : 0.0021)) * (pose === "sleepy" ? 3 : pose === "celebrate" ? 7 : 4);
      const sway = Math.sin(time * (pose === "playful" ? 0.003 : 0.0012)) * (pose === "playful" ? 5 : 1.7);
      const pointer = pointerRef.current ?? propsRef.current.mouseDelta ?? { x: 0, y: 0 };
      const facingFlip = pose === "front" || pose === "front_three_quarter" || pose === "side" || pose === "back" ? (pointer.x < 0 ? -1 : 1) : 1;
      const drawX = baseX + sway + poseTransform.offsetX;
      const drawY = baseY + bob + poseTransform.offsetY;
      const angle = ((globalRotate + poseTransform.rotate) * Math.PI) / 180;
      const pulse = 1 + Math.sin(time * (pose === "sleepy" ? 0.0014 : 0.0028)) * (pose === "playful" ? 0.012 : 0.008);
      const rotate = angle + (pointer.x * 0.08) + (pointer.y * 0.05);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(drawX, drawY);
      ctx.rotate(rotate);
      ctx.scale(facingFlip * pulse, pulse);
      ctx.shadowColor = "rgba(82, 54, 18, .26)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.drawImage(
        image,
        source.x,
        source.y,
        source.w,
        source.h,
        -renderW / 2,
        -renderH / 2,
        renderW,
        renderH
      );
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.shadowColor = "transparent";
      ctx.drawImage(
        image,
        source.x,
        source.y,
        source.w,
        source.h,
        -renderW / 2,
        -renderH / 2,
        renderW,
        renderH
      );
      ctx.restore();
    };

    const draw = (time: number) => {
      const image = imageRef.current;
      const { compact: isCompact, mouseDelta: currentMouseDelta } = propsRef.current;
      const pointer = pointerRef.current ?? currentMouseDelta ?? { x: 0, y: 0 };
      const pointerMagnitude = clamp(Math.hypot(pointer.x, pointer.y), 0, 0.75);
      const pointerLift = clamp(-pointer.y * 12, -6, 8);
      const pointerShift = pointer.x * (isCompact ? 5 : 14);
      const baseScale = isCompact ? 0.86 : 0.94;

      ctx.clearRect(0, 0, width, height);

      const glow = ctx.createRadialGradient(
        width / 2,
        height * 0.4,
        10,
        width / 2,
        height * 0.42,
        Math.max(width, height) * 0.5
      );
      glow.addColorStop(0, `rgba(88, 121, 109, ${0.18 + pointerMagnitude * 0.12})`);
      glow.addColorStop(0.4, "rgba(88, 121, 109, .08)");
      glow.addColorStop(1, "rgba(88, 121, 109, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.translate(width / 2, height * 0.84);
      ctx.fillStyle = "rgba(26, 45, 58, .12)";
      ctx.filter = "blur(6px)";
      ctx.beginPath();
      ctx.ellipse(0, 0, width * 0.18, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.translate(width / 2, height * 0.45);
      const support = ctx.createRadialGradient(0, 0, 12, 0, 0, Math.max(width, height) * 0.18);
      support.addColorStop(0, "rgba(248, 229, 196, .55)");
      support.addColorStop(0.55, "rgba(248, 229, 196, .22)");
      support.addColorStop(1, "rgba(248, 229, 196, 0)");
      ctx.fillStyle = support;
      ctx.beginPath();
      ctx.ellipse(0, 0, width * 0.22, height * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (image) {
        const { theme, previous, startedAt } = themeStateRef.current;
        const clip = POSE_CLIPS[theme];
        const prevClip = POSE_CLIPS[previous];
        const transitionMix = previous === theme ? 1 : smoothstep((time - startedAt) / 220);
        const currentProgress = ((time - startedAt) % clip.duration) / clip.duration;
        const previousProgress = ((time - startedAt) % prevClip.duration) / prevClip.duration;
        const currentPair = resolveFramePair(clip, currentProgress);
        const previousPair = resolveFramePair(prevClip, previousProgress);

        const activeScale = baseScale * (theme === "celebrate" ? 1.02 : theme === "sleepy" ? 0.96 : 1);
        const activeRotate = clamp(pointer.x * 4, -6, 6);
        const centerX = width / 2 + pointerShift;
        const centerY = height / 2 + pointerLift + (theme === "sleepy" ? 6 : 0);
        const drawWidth = width * activeScale;
        const drawHeight = height * activeScale;
        const widthPx = Math.min(drawWidth, drawHeight * 0.92);
        const heightPx = widthPx / 0.92;

        if (previous !== theme) {
          drawPose(previousPair.from.pose, 1 - transitionMix, time, centerX, centerY, activeScale, activeRotate, widthPx, heightPx);
          drawPose(previousPair.to.pose, 0.22 * (1 - transitionMix), time, centerX, centerY, activeScale * 1.01, activeRotate, widthPx, heightPx);
        }

        drawPose(currentPair.from.pose, previous === theme ? 1 : transitionMix, time, centerX, centerY, activeScale, activeRotate, widthPx, heightPx);
        if (currentPair.from.pose !== currentPair.to.pose) {
          drawPose(currentPair.to.pose, 0.24 * (previous === theme ? 1 : transitionMix), time, centerX, centerY, activeScale * 1.01, activeRotate, widthPx, heightPx);
        }

        if (theme === "celebrate" || propsRef.current.reaction === "celebrate") {
          ctx.strokeStyle = "rgba(88, 121, 109, .36)";
          ctx.lineWidth = 1.3;
          ctx.save();
          ctx.translate(width / 2, height * 0.34);
          for (const [sx, sy, len] of [
            [-34, -14, 6],
            [34, -18, 5],
            [-18, -34, 4],
            [22, -36, 4],
          ] as const) {
            ctx.beginPath();
            ctx.moveTo(sx - len, sy);
            ctx.lineTo(sx + len, sy);
            ctx.moveTo(sx, sy - len);
            ctx.lineTo(sx, sy + len);
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      raf = window.requestAnimationFrame(draw);
    };

    raf = window.requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(raf);
    };
  }, [compact]);

  return (
    <canvas
      ref={canvasRef}
      className="live-character-pet"
      aria-hidden="true"
      style={canvasStyle}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = clamp((event.clientX - rect.left - rect.width / 2) / rect.width, -0.5, 0.5);
        const y = clamp((event.clientY - rect.top - rect.height / 2) / rect.height, -0.5, 0.5);
        pointerRef.current = { x, y };
      }}
      onPointerLeave={() => {
        pointerRef.current = null;
      }}
      title={ready ? undefined : "loading"}
    />
  );
}
