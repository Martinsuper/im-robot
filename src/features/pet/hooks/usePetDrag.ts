import { useEffect, useRef, useState } from "react";
import {
  isTauriRuntime,
  reportCommandError,
  runCommand,
} from "../../app/appRuntime";

const DRAG_THRESHOLD_PX = 4;
const STROKE_DISTANCE_PX = 24;
const STROKE_DISPLACEMENT_PX = 16;
const LONG_PRESS_MS = 520;

function distanceBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pathDistance(samples: Array<{ x: number; y: number }>) {
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    total += distanceBetween(samples[index - 1], samples[index]);
  }
  return total;
}

function displacement(samples: Array<{ x: number; y: number }>) {
  if (samples.length < 2) return 0;
  return distanceBetween(samples[0], samples[samples.length - 1]);
}

export interface UsePetDragOptions {
  onDragEnd?: (distance: number) => void;
  onStroke?: (distance: number, duration: number) => void;
  onClick?: () => void;
  onLongPress?: (position: { x: number; y: number }) => void;
  onLongPressStart?: () => void;
  onLongPressEnd?: () => void;
}

export interface UsePetDragReturn {
  isDragging: boolean;
  isLongPressing: boolean;
  handlers: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerCancel: () => void;
    onClick: () => void;
  };
}

export function usePetDrag(options: UsePetDragOptions): UsePetDragReturn {
  const {
    onDragEnd,
    onStroke,
    onClick,
    onLongPress,
    onLongPressStart,
    onLongPressEnd,
  } = options;

  const [isDragging, setIsDragging] = useState(false);
  const [isLongPressing, setIsLongPressing] = useState(false);
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number } | null>(
    null,
  );
  const dragOffset = useRef({ x: 0, y: 0 });
  const didDrag = useRef(false);
  const dragSamples = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const inertiaFrame = useRef<number>(0);
  const longPressTimer = useRef<number>(0);
  const longPressTriggered = useRef(false);
  const suppressClickRef = useRef(false);
  const isPrimaryPointerDown = useRef(false);
  const petPos = useRef({ x: 0, y: 0 });

  const gesture = useRef(0);
  const moveVersion = useRef(0);
  const positionReady = useRef(false);
  const latestPointer = useRef({ x: 0, y: 0 });
  const settleWhenReady = useRef(false);
  const moveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const visualInsets = useRef<[number, number, number, number]>([0, 0, 0, 0]);

  function snapToEdge() {
    const activeGesture = gesture.current;
    moveQueue.current = moveQueue.current
      .then(async () => {
        if (gesture.current !== activeGesture) return;
        const [x, y] = await runCommand<[number, number]>("move_pet", {
          ...petPos.current,
          snapInsets: visualInsets.current,
        });
        if (gesture.current === activeGesture) petPos.current = { x, y };
      })
      .catch(reportCommandError("move_pet"));
  }

  function movePet(x: number, y: number) {
    const requested = { x: Math.round(x), y: Math.round(y) };
    const activeGesture = gesture.current;
    const version = ++moveVersion.current;
    petPos.current = requested;
    moveQueue.current = moveQueue.current
      .then(async () => {
        // Keep only the most recent pointer position when native IPC falls behind.
        if (
          gesture.current !== activeGesture ||
          moveVersion.current !== version
        )
          return;
        const [actualX, actualY] = await runCommand<[number, number]>(
          "move_pet",
          requested,
        );
        if (
          gesture.current === activeGesture &&
          moveVersion.current === version
        ) {
          petPos.current = { x: actualX, y: actualY };
        }
      })
      .catch(reportCommandError("move_pet"));
  }

  function movePetBy(dx: number, dy: number) {
    movePet(petPos.current.x + dx, petPos.current.y + dy);
  }

  function stopInertia() {
    if (inertiaFrame.current) {
      window.cancelAnimationFrame(inertiaFrame.current);
      inertiaFrame.current = 0;
    }
  }

  function startInertia() {
    if (!isTauriRuntime) return;
    if (!positionReady.current) {
      settleWhenReady.current = true;
      return;
    }
    if (dragSamples.current.length < 2) {
      snapToEdge();
      return;
    }
    const samples = dragSamples.current;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = Math.max(16, last.t - first.t);
    let vx = ((last.x - first.x) / dt) * 16;
    let vy = ((last.y - first.y) / dt) * 16;
    if (Math.hypot(vx, vy) < 1.4) {
      snapToEdge();
      return;
    }

    stopInertia();
    const coast = () => {
      vx *= 0.88;
      vy *= 0.88;
      if (Math.hypot(vx, vy) < 0.45) {
        inertiaFrame.current = 0;
        snapToEdge();
        return;
      }
      movePetBy(vx, vy);
      inertiaFrame.current = window.requestAnimationFrame(coast);
    };
    inertiaFrame.current = window.requestAnimationFrame(coast);
  }

  function rememberDragPoint(x: number, y: number) {
    dragSamples.current = [
      ...dragSamples.current.slice(-5),
      { x, y, t: performance.now() },
    ];
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (!isTauriRuntime || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect?.();
    if (rect)
      visualInsets.current = [
        rect.left,
        rect.top,
        window.innerWidth - rect.right,
        window.innerHeight - rect.bottom,
      ];
    event.currentTarget.setPointerCapture(event.pointerId);
    isPrimaryPointerDown.current = true;
    const activeGesture = ++gesture.current;
    positionReady.current = false;
    settleWhenReady.current = false;
    latestPointer.current = { x: event.screenX, y: event.screenY };
    stopInertia();
    didDrag.current = false;
    longPressTriggered.current = false;
    suppressClickRef.current = false;
    dragSamples.current = [
      { x: event.screenX, y: event.screenY, t: performance.now() },
    ];

    // 立即清除旧的长按定时器，避免与新的拖动冲突
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = 0;
    }

    // 启动长按状态（用于显示进度环）
    setIsLongPressing(true);
    onLongPressStart?.();

    // 重新启动长按定时器
    longPressTimer.current = window.setTimeout(() => {
      if (!didDrag.current) {
        longPressTriggered.current = true;
        setIsLongPressing(false);
        onLongPressEnd?.();
        onLongPress?.({ x: event.clientX, y: event.clientY });
      }
    }, LONG_PRESS_MS);

    // Read after any in-flight native move; a new gesture invalidates queued old moves.
    moveQueue.current = moveQueue.current
      .then(() => {
        if (gesture.current !== activeGesture) return;
        return runCommand<[number, number]>("get_pet_position", undefined, [
          petPos.current.x,
          petPos.current.y,
        ]);
      })
      .then((position) => {
        if (!position || gesture.current !== activeGesture) return;
        const [x, y] = position;
        petPos.current = { x, y };
        dragOffset.current = { x: event.screenX - x, y: event.screenY - y };
        positionReady.current = true;
        if (didDrag.current) {
          movePet(
            latestPointer.current.x - dragOffset.current.x,
            latestPointer.current.y - dragOffset.current.y,
          );
        }
        if (settleWhenReady.current) snapToEdge();
      })
      .catch(reportCommandError("get_pet_position"));
    setDragOrigin({ x: event.screenX, y: event.screenY });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (event.button !== 0 || !isPrimaryPointerDown.current) return;
    isPrimaryPointerDown.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    // 清除长按状态
    setIsLongPressing(false);
    onLongPressEnd?.();

    if (didDrag.current) {
      startInertia();
      const distance = pathDistance(dragSamples.current);
      onDragEnd?.(distance);
      suppressClickRef.current = true;
    } else if (longPressTriggered.current) {
      suppressClickRef.current = true;
    } else {
      const totalDistance = pathDistance(dragSamples.current);
      const totalDisplacement = displacement(dragSamples.current);
      const durationMs =
        dragSamples.current.length > 1
          ? dragSamples.current[dragSamples.current.length - 1].t -
            dragSamples.current[0].t
          : 0;

      if (
        dragSamples.current.length > 1 &&
        totalDistance >= STROKE_DISTANCE_PX &&
        totalDisplacement <= STROKE_DISPLACEMENT_PX &&
        durationMs >= 120
      ) {
        onStroke?.(totalDistance, durationMs);
      } else {
        onClick?.();
      }
      suppressClickRef.current = true;
    }
    setIsDragging(false);
    setDragOrigin(null);
    dragSamples.current = [];
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if ((event.buttons & 1) === 0 || !isTauriRuntime) return;
    if (!dragOrigin) return;
    latestPointer.current = { x: event.screenX, y: event.screenY };
    rememberDragPoint(event.screenX, event.screenY);
    const dx = event.screenX - dragOrigin.x;
    const dy = event.screenY - dragOrigin.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;

    // 超过拖动阈值，立即清除长按定时器和状态，避免冲突
    didDrag.current = true;
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = 0;
    }
    setIsLongPressing(false);
    onLongPressEnd?.();
    setIsDragging(true);
    event.preventDefault();
    if (positionReady.current)
      movePet(
        event.screenX - dragOffset.current.x,
        event.screenY - dragOffset.current.y,
      );
  };

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
      isPrimaryPointerDown.current = false;
      gesture.current += 1;
      stopInertia();
    };
  }, []);

  return {
    isDragging,
    isLongPressing,
    handlers: {
      onPointerDown,
      onPointerUp,
      onPointerMove,
      onPointerCancel: () => {
        gesture.current += 1;
        stopInertia();
        isPrimaryPointerDown.current = false;
        if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
        setIsDragging(false);
        setIsLongPressing(false);
        setDragOrigin(null);
        dragSamples.current = [];
        onLongPressEnd?.();
        suppressClickRef.current = true;
      },
      onClick: handleClick,
    },
  };
}
