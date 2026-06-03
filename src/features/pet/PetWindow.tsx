import { useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, PetVisualEvent, QuietMode, Theme } from "../../types/appTypes";
import { PetSprite, defaultAppSettings, useCurrentTime } from "../app/appShared";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { initialPetState, reducePetState } from "./petState";
import type { ChatEvent } from "../chat/chatTypes";

export function PetWindow() {
  const [petState, dispatch] = useReducer(reducePetState, initialPetState);
  const [companionName, setCompanionName] = useState("Piko");
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [sensingPaused, setSensingPaused] = useState(false);
  const [theme, setTheme] = useState<Theme>("sage");
  const currentTime = useCurrentTime();
  const isResting = petState.mode === "resting";
  const resetTimer = useRef<number | undefined>(undefined);

  function resetAfter(delay = 1400) {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => dispatch({ type: "RESET" }), delay);
  }

  function showTransient(event: Parameters<typeof dispatch>[0], delay?: number) {
    dispatch(event);
    resetAfter(delay);
  }

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setCompanionName(settings.companionName);
      setQuietMode(settings.quietMode);
      setSensingPaused(settings.sensingPaused);
      setTheme(settings.theme);
    });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.type === "started") {
        dispatch({ type: event.payload.working ? "WORK_STARTED" : "CHAT_SUBMITTED" });
      }
      if (event.payload.type === "delta") dispatch({ type: "CHAT_STREAM_STARTED" });
      if (event.payload.type === "completed") showTransient({ type: "CHAT_COMPLETED" });
      if (event.payload.type === "cancelled") dispatch({ type: "RESET" });
      if (event.payload.type === "failed") {
        showTransient({ type: "FAILED", message: event.payload.message }, 2400);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<PetVisualEvent>("pet-visual-event", (event) => {
      if (event.payload.type === "attachment-ready") {
        showTransient({ type: "ATTACHMENT_READY" }, 2200);
      }
      if (event.payload.type === "reminder-fired") {
        showTransient({ type: "REMINDER_FIRED", message: event.payload.message }, 2600);
      }
      if (event.payload.type === "ambient-nudge") {
        showTransient({ type: "AMBIENT_NUDGE" }, 1800);
      }
      if (event.payload.type === "break-reminder") {
        showTransient({ type: "BREAK_REMINDER", message: event.payload.message }, 2600);
      }
      if (event.payload.type === "idle-started") {
        dispatch({ type: "REST" });
      }
      if (event.payload.type === "idle-ended") {
        showTransient({ type: "WAKE" }, 1800);
      }
      if (event.payload.type === "focus-started") {
        dispatch({ type: "WORK_STARTED" });
      }
      if (event.payload.type === "focus-completed") {
        showTransient({ type: "CHAT_COMPLETED" }, 2600);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const unlisten = listen<AppSettings>("settings-updated", (event) => {
      setCompanionName(event.payload.companionName);
      setQuietMode(event.payload.quietMode);
      setSensingPaused(event.payload.sensingPaused);
      setTheme(event.payload.theme);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
  }, []);

  function toggleRest() {
    dispatch({ type: isResting ? "WAKE" : "REST" });
  }

  const DRAG_THRESHOLD_PX = 4;
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);

  return (
    <main
      className={`pet-stage pet-stage--${theme} pet-stage--${quietMode}${sensingPaused ? " is-sensing-paused" : ""}`}
      aria-label={`桌面精灵 ${companionName}`}
      onMouseDown={(event) => {
        if (!isTauriRuntime) return;
        didDrag.current = false;
        setDragOrigin({ x: event.screenX, y: event.screenY });
      }}
      onMouseUp={() => setDragOrigin(null)}
      onMouseMove={(event) => {
        if ((event.buttons & 1) === 0 || !isTauriRuntime) return;
        if (!dragOrigin) return;
        const dx = event.screenX - dragOrigin.x;
        const dy = event.screenY - dragOrigin.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        didDrag.current = true;
        event.preventDefault();
        void runCommand("move_pet", { x: event.screenX - 78, y: event.screenY - 70 });
      }}
    >
      <div
        className={`pet pet--${petState.mode} pet-reaction--${petState.reaction}`}
        aria-label="拖动 Piko"
        onClick={() => {
          if (didDrag.current) {
            didDrag.current = false;
            return;
          }
          if (!isResting) showTransient({ type: "INTERACT" });
          void runCommand("show_bubble");
        }}
      >
        <PetSprite mode={petState.mode} />
        <time className="pet-clock" aria-label={`当前时间 ${currentTime}`}>
          {currentTime}
        </time>
        <span className={`pet-emotion pet-emotion--${petState.emotion}`} aria-hidden="true" />
      </div>
      <div className="pet-actions">
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            dispatch({ type: "LISTEN" });
            void runCommand("show_bubble");
          }}
        >
          对话
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={toggleRest}
        >
          {isResting ? "唤醒" : "休息"}
        </button>
        <button className="icon-button" type="button" onClick={() => runCommand("open_panel")}>
          面板
        </button>
      </div>
      <p className="pet-status" aria-live="polite">
        {petState.message}
      </p>
    </main>
  );
}
