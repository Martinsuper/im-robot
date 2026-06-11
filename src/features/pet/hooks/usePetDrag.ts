import { useEffect, useRef, useState } from "react";
import { isTauriRuntime, runCommand } from "../../app/appRuntime";

const DRAG_THRESHOLD_PX = 4;
const STROKE_DISTANCE_PX = 24;
const STROKE_DISPLACEMENT_PX = 16;
const LONG_PRESS_MS = 520;

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
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
}

export interface UsePetDragReturn {
  isDragging: boolean;
  handlers: {
    onMouseDown: (event: React.MouseEvent) => void;
    onMouseUp: () => void;
    onMouseMove: (event: React.MouseEvent) => void;
    onClick: () => void;
  };
}

export function usePetDrag(options: UsePetDragOptions): UsePetDragReturn {
  const { onDragEnd, onStroke, onClick, onLongPress } = options;

  const [isDragging, setIsDragging] = useState(false);
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const didDrag = useRef(false);
  const dragSamples = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const inertiaFrame = useRef<number>(0);
  const longPressTimer = useRef<number>(0);
  const longPressTriggered = useRef(false);
  const suppressClickRef = useRef(false);
  const petPos = useRef({ x: 0, y: 0 });

  function movePet(x: number, y: number) {
    const requested = { x: Math.round(x), y: Math.round(y) };
    petPos.current = requested;
    void runCommand<[number, number]>("move_pet", requested).then(([actualX, actualY]) => {
      petPos.current = { x: actualX, y: actualY };
    });
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
    if (!isTauriRuntime || dragSamples.current.length < 2) return;
    const samples = dragSamples.current;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = Math.max(16, last.t - first.t);
    let vx = ((last.x - first.x) / dt) * 16;
    let vy = ((last.y - first.y) / dt) * 16;
    if (Math.hypot(vx, vy) < 1.4) return;

    stopInertia();
    const coast = () => {
      vx *= 0.88;
      vy *= 0.88;
      if (Math.hypot(vx, vy) < 0.45) {
        inertiaFrame.current = 0;
        return;
      }
      movePetBy(vx, vy);
      inertiaFrame.current = window.requestAnimationFrame(coast);
    };
    inertiaFrame.current = window.requestAnimationFrame(coast);
  }

  function rememberDragPoint(x: number, y: number) {
    dragSamples.current = [...dragSamples.current.slice(-5), { x, y, t: performance.now() }];
  }

  const onMouseDown = (event: React.MouseEvent) => {
    if (!isTauriRuntime || event.button !== 0) return;
    stopInertia();
    didDrag.current = false;
    longPressTriggered.current = false;
    suppressClickRef.current = false;
    dragSamples.current = [{ x: event.screenX, y: event.screenY, t: performance.now() }];
    longPressTimer.current = window.setTimeout(() => {
      if (!didDrag.current) {
        longPressTriggered.current = true;
        onLongPress?.({ x: event.clientX, y: event.clientY });
      }
    }, LONG_PRESS_MS);
    void runCommand<[number, number]>("get_pet_position", undefined, [petPos.current.x, petPos.current.y])
      .then(([x, y]) => {
        petPos.current = { x, y };
        dragOffset.current = {
          x: event.screenX - x,
          y: event.screenY - y,
        };
      });
    setDragOrigin({ x: event.screenX, y: event.screenY });
  };

  const onMouseUp = () => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
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
      const durationMs = dragSamples.current.length > 1
        ? dragSamples.current[dragSamples.current.length - 1].t - dragSamples.current[0].t
        : 0;

      if (dragSamples.current.length > 1 && totalDistance >= STROKE_DISTANCE_PX && totalDisplacement <= STROKE_DISPLACEMENT_PX && durationMs >= 120) {
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

  const onMouseMove = (event: React.MouseEvent) => {
    if ((event.buttons & 1) === 0 || !isTauriRuntime) return;
    if (!dragOrigin) return;
    rememberDragPoint(event.screenX, event.screenY);
    const dx = event.screenX - dragOrigin.x;
    const dy = event.screenY - dragOrigin.y;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    didDrag.current = true;
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    setIsDragging(true);
    rememberDragPoint(event.screenX, event.screenY);
    event.preventDefault();
    movePet(event.screenX - dragOffset.current.x, event.screenY - dragOffset.current.y);
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
      stopInertia();
    };
  }, []);

  return {
    isDragging,
    handlers: {
      onMouseDown,
      onMouseUp,
      onMouseMove,
      onClick: handleClick,
    },
  };
}
