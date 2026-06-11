import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AppSettings, PetVisualEvent, QuietMode, Theme } from "../../types/appTypes";
import {
  PetSprite,
  defaultAppSettings,
  defaultLive2DModelId,
  getNextLive2DModelId,
  getNextPetVisualStyle,
  live2dModelOptions,
  setLive2DModelId,
  setPetVisualStyle,
  useCurrentTime,
  useLive2DModelId,
  usePetVisualStyle,
} from "../app/appShared";
import { runCommand } from "../app/appRuntime";
import { initialPetState, reducePetState } from "./petState";
import { setBubbleCompanionMessage } from "../chat/bubbleMessage";
import type { ChatEvent } from "../chat/chatTypes";
import * as audio from "./petAudio";
import {
  describePersonality,
  loadPersonalityState,
  recordPersonalitySignalFromInteraction,
} from "./personality";
import {
  loadInteractionStats,
  getPetSpeechFallbackForInteraction,
  getPetSpeechForInteraction,
  type HumanInteractionEvent,
  type PetMotionStyle,
} from "./interaction";
import { usePetDrag } from "./hooks/usePetDrag";
import { usePetNotice } from "./hooks/usePetNotice";
import { useTauriEventSubscription } from "./hooks/useTauriEventSubscription";
import { PetDomainProvider, usePetDomain } from "./context/PetDomainContext";

interface IdleRhythmProfile {
  fidgetDelayMin: number;
  fidgetDelayMax: number;
  fidgetResetDelay: number;
  attentionPulseAfterSeconds: number;
  attentionPulseIntervalMs: number;
}

function getIdleRhythmProfile(style: PetMotionStyle): IdleRhythmProfile {
  switch (style) {
    case "soft":
      return {
        fidgetDelayMin: 17000,
        fidgetDelayMax: 30000,
        fidgetResetDelay: 1100,
        attentionPulseAfterSeconds: 20,
        attentionPulseIntervalMs: 6500,
      };
    case "lively":
      return {
        fidgetDelayMin: 7000,
        fidgetDelayMax: 15000,
        fidgetResetDelay: 1400,
        attentionPulseAfterSeconds: 10,
        attentionPulseIntervalMs: 3500,
      };
    default:
      return {
        fidgetDelayMin: 11000,
        fidgetDelayMax: 20000,
        fidgetResetDelay: 1300,
        attentionPulseAfterSeconds: 15,
        attentionPulseIntervalMs: 5000,
      };
  }
}

function PetWindowContent() {
  const [petState, dispatch] = useReducer(reducePetState, initialPetState);
  const [companionName, setCompanionName] = useState("Piko");
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [sensingPaused, setSensingPaused] = useState(false);
  const [theme, setTheme] = useState<Theme>("sage");
  const currentTime = useCurrentTime();
  const isResting = petState.mode === "resting";
  const resetTimer = useRef<number | undefined>(undefined);
  const [mouseDelta, setMouseDelta] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const petRef = useRef<HTMLDivElement>(null);
  const [attentionPulse, setAttentionPulse] = useState(false);
  const idleStartRef = useRef(Date.now());
  const petVisualStyle = usePetVisualStyle();
  const live2dModelId = useLive2DModelId();
  const noticeTimer = useRef<number>(0);
  const behaviorNoticeTimer = useRef<number>(0);

  const {
    motionStyle,
    bondTier,
    personalitySnapshot,
    interactionManager,
    personalityManager,
    updateGrowth,
    recordInteraction,
    evaluateBehavior,
  } = usePetDomain();

  const { notice: petNotice, showNotice: showPetNotice, clearNotice: clearPetNotice } = usePetNotice();

  const idleRhythm = useMemo(() => getIdleRhythmProfile(motionStyle), [motionStyle]);

  const { isDragging, handlers: dragHandlers } = usePetDrag({
    onDragEnd: (distance) => {
      handleHumanInteraction({
        type: "drag_end",
        timestamp: Date.now(),
        payload: { distancePx: distance },
      });
    },
    onStroke: (distance, duration) => {
      handleHumanInteraction({
        type: "pet_stroke",
        timestamp: Date.now(),
        intensity: Math.min(1, distance / 120),
        payload: { durationMs: duration, distancePx: distance },
      });
    },
    onClick: () => {
      handleHumanInteraction({ type: "click", timestamp: Date.now() });
    },
    onLongPress: (position) => {
      setContextMenu({ x: position.x, y: position.y });
    },
  });

  function handleHumanInteraction(event: HumanInteractionEvent) {
    const result = interactionManager.handle(event, {
      quietMode,
      petMode: petState.mode,
      petEmotion: petState.emotion,
      isResting,
      recentInteractionCount: loadInteractionStats().totalInteractions,
      lastInteractionAt: loadInteractionStats().lastInteractionAt ?? undefined,
      intimacy: loadInteractionStats().intimacy ?? 0,
      energy: 1,
    });

    if (result.saveStats) {
      updateGrowth(event);
    }

    const personalitySignal = recordPersonalitySignalFromInteraction(event);
    if (personalitySignal) {
      recordInteraction(personalitySignal);
    }

    evaluateBehavior();

    const livePersonality = personalityManager.getState() ?? personalitySnapshot;

    if (result.petEvent) {
      dispatch(result.petEvent);
    }

    if (result.sound && quietMode !== "minimal") {
      switch (result.sound) {
        case "click":
          audio.click();
          break;
        case "greet":
          audio.playGreet();
          break;
        case "curious":
          audio.playCurious();
          break;
        case "celebrate":
          audio.playCelebrate();
          break;
        case "notice":
          audio.playNotice();
          break;
        case "error":
          audio.playError();
          break;
        case "wake":
          audio.playWake();
          break;
        case "drop":
          audio.playDrop();
          break;
      }
    }

    if (result.openBubble) {
      setBubbleCompanionMessage(getPetSpeechFallbackForInteraction(event.type, bondTier));
      void getPetSpeechForInteraction(event.type, bondTier, livePersonality, describePersonality(livePersonality)).then((message) => {
        setBubbleCompanionMessage(message);
      });
      void runCommand("show_bubble");
    }

    if (result.openPanel) {
      void runCommand("open_panel");
    }
  }

  function showCompanionNotice(
    eventType: string,
    fallbackMessage: string,
    durationMs = 2600
  ) {
    const livePersonality = personalityManager.getState() ?? personalitySnapshot;
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    showPetNotice(fallbackMessage, durationMs);

    void getPetSpeechForInteraction(eventType, bondTier, livePersonality, describePersonality(livePersonality)).then((message) => {
      showPetNotice(message, durationMs);
    });
  }

  function scheduleFidget() {
    const delay = idleRhythm.fidgetDelayMin + Math.random() * (idleRhythm.fidgetDelayMax - idleRhythm.fidgetDelayMin);
    const fidgetTimer = window.setTimeout(() => {
      if (petState.mode === "idle") {
        dispatch({
          type: "FIDGET",
          intensity: motionStyle === "soft" ? "soft" : "normal",
        });
        const fidgetResetTimer = window.setTimeout(() => {
          if (petState.mode === "idle") dispatch({ type: "RESET" });
        }, idleRhythm.fidgetResetDelay);
        return () => window.clearTimeout(fidgetResetTimer);
      }
      scheduleFidget();
    }, delay);
    return () => window.clearTimeout(fidgetTimer);
  }

  useEffect(() => {
    if (petState.mode === "idle") {
      idleStartRef.current = Date.now();
    } else {
      setAttentionPulse(false);
    }
  }, [petState.mode, quietMode, motionStyle]);

  useEffect(() => {
    if (petState.mode !== "idle" || quietMode === "minimal") {
      setAttentionPulse(false);
      return;
    }
    const interval = window.setInterval(() => {
      const idleSeconds = (Date.now() - idleStartRef.current) / 1000;
      if (idleSeconds > idleRhythm.attentionPulseAfterSeconds) {
        setAttentionPulse(true);
      } else {
        setAttentionPulse(false);
      }
    }, idleRhythm.attentionPulseIntervalMs);
    return () => window.clearInterval(interval);
  }, [petState.mode, quietMode, idleRhythm]);

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setCompanionName(settings.companionName);
      setQuietMode(settings.quietMode);
      setSensingPaused(settings.sensingPaused);
      setTheme(settings.theme);
    });
  }, []);

  // Chat event subscription
  useTauriEventSubscription<ChatEvent>("chat-event", (event) => {
    if (event.type === "started") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: event.working ? "focus_started" : "chat_submitted" })
          ?? { type: event.working ? "work" : "chat", timestamp: Date.now(), intensity: 0.5 }
      );
      dispatch({ type: event.working ? "WORK_STARTED" : "CHAT_SUBMITTED" });
    }
    if (event.type === "delta") {
      dispatch({ type: "CHAT_STREAM_STARTED" });
    }
    if (event.type === "completed") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "chat_completed" })
          ?? { type: "celebrate", timestamp: Date.now(), intensity: 0.8 }
      );
      dispatch({ type: "CHAT_COMPLETED" });
    }
    if (event.type === "cancelled") dispatch({ type: "RESET" });
    if (event.type === "failed") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "FAILED" })
          ?? { type: "work", timestamp: Date.now(), intensity: 0.8 }
      );
      dispatch({ type: "FAILED", message: event.message });
    }
  }, [quietMode, bondTier]);

  // Pet visual event subscription
  useTauriEventSubscription<PetVisualEvent>("pet-visual-event", (event) => {
    if (event.type === "attachment-ready") {
      dispatch({ type: "ATTACHMENT_READY" });
    }
    if (event.type === "reminder-fired") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "break_reminder" })
          ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
      );
      dispatch({ type: "REMINDER_FIRED", message: event.message });
      showCompanionNotice("break_reminder", event.message, 3600);
    }
    if (event.type === "calendar-event-due") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "break_reminder" })
          ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
      );
      dispatch({ type: "REMINDER_FIRED", message: event.message });
      showCompanionNotice("break_reminder", event.message, 3600);
    }
    if (event.type === "ambient-nudge") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "ambient_nudge" })
          ?? { type: "idle", timestamp: Date.now(), intensity: 0.5 }
      );
      dispatch({ type: "AMBIENT_NUDGE" });
      showCompanionNotice("ambient_nudge", "Piko 轻轻看了你一眼。", 2400);
    }
    if (event.type === "break-reminder") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "break_reminder" })
          ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
      );
      dispatch({ type: "BREAK_REMINDER", message: event.message });
      showCompanionNotice("break_reminder", event.message, 4200);
    }
    if (event.type === "idle-started") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "user_idle_started" })
          ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
      );
      dispatch({ type: "REST" });
      showCompanionNotice("user_idle_started", "Piko 安静下来陪你休息。", 2800);
    }
    if (event.type === "idle-ended") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "user_idle_ended" })
          ?? { type: "idle", timestamp: Date.now(), intensity: 0.2 }
      );
      dispatch({ type: "WAKE" });
      showCompanionNotice("user_idle_ended", "欢迎回来。", 2800);
    }
    if (event.type === "focus-started") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "focus_started" })
          ?? { type: "work", timestamp: Date.now(), intensity: 0.7 }
      );
      dispatch({ type: "WORK_STARTED" });
      showCompanionNotice("focus_started", "Piko 正在放轻脚步。", 2200);
    }
    if (event.type === "focus-completed") {
      personalityManager.recordInteraction(
        recordPersonalitySignalFromInteraction({ type: "focus_completed" })
          ?? { type: "celebrate", timestamp: Date.now(), intensity: 0.8 }
      );
      dispatch({ type: "CHAT_COMPLETED" });
      showCompanionNotice("focus_completed", "做完啦，来看看结果。", 3200);
    }
  }, [quietMode, bondTier]);

  // Settings updated subscription
  useTauriEventSubscription<AppSettings>("settings-updated", (event) => {
    setCompanionName(event.companionName);
    setQuietMode(event.quietMode);
    setSensingPaused(event.sensingPaused);
    setTheme(event.theme);
  }, []);

  useEffect(() => {
    const refreshProfile = () => {
      // Reload personality and stats from storage when they change externally
      loadPersonalityState(personalityManager.getState());
      loadInteractionStats();
    };
    window.addEventListener("storage", refreshProfile);
    window.addEventListener("piko-interaction-stats-changed", refreshProfile);
    window.addEventListener("piko-growth-state-changed", refreshProfile);
    return () => {
      window.removeEventListener("storage", refreshProfile);
      window.removeEventListener("piko-interaction-stats-changed", refreshProfile);
      window.removeEventListener("piko-growth-state-changed", refreshProfile);
    };
  }, []);

  useEffect(() => () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (behaviorNoticeTimer.current) window.clearTimeout(behaviorNoticeTimer.current);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (petState.mode === "idle" && quietMode !== "minimal") {
      return scheduleFidget();
    }
  }, [petState.mode, quietMode, idleRhythm]);

  const prevReaction = useRef(petState.reaction);
  const prevEmotion = useRef(petState.emotion);

  useEffect(() => {
    if (quietMode === "minimal") {
      prevReaction.current = petState.reaction;
      return;
    }
    if (petState.reaction !== prevReaction.current) {
      switch (petState.reaction) {
        case "greet": audio.playGreet(); break;
        case "celebrate": audio.playCelebrate(); break;
        case "notice":
          if (petState.emotion === "curious") audio.playCurious();
          else if (petState.emotion === "surprised") audio.playSurprised();
          else audio.playNotice();
          break;
        case "idle_fidget": audio.playCurious(); break;
      }
      prevReaction.current = petState.reaction;
    }
  }, [petState.reaction, petState.emotion, quietMode]);

  useEffect(() => {
    if (quietMode === "minimal") {
      prevEmotion.current = petState.emotion;
      return;
    }
    if (petState.emotion !== prevEmotion.current) {
      switch (petState.emotion) {
        case "happy":
          if (petState.mode === "success") audio.playSuccess();
          break;
        case "worried":
          if (petState.mode === "error") audio.playError();
          break;
      }
      prevEmotion.current = petState.emotion;
    }
  }, [petState.emotion, petState.mode, quietMode]);

  return (
    <main
      className={`pet-stage pet-stage--${theme} pet-stage--${quietMode}${sensingPaused ? " is-sensing-paused" : ""}`}
      aria-label={`桌面精灵 ${companionName}`}
      {...dragHandlers}
    >
      {petNotice && (
        <button
          className="pet-notice-bubble"
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            clearPetNotice();
          }}
          aria-label="关闭提醒"
        >
          {petNotice}
        </button>
      )}
      <div
        ref={petRef}
        className={`pet pet--${petVisualStyle} pet--${petState.mode} pet--bond-${bondTier} pet-reaction--${petState.reaction}${isDragOver ? " is-drag-over" : ""}${isDragging ? " is-dragging" : ""}${attentionPulse ? " is-attention-pulse" : ""}`}
        aria-label="拖动 Piko"
        onMouseEnter={() => {
          handleHumanInteraction({
            type: "hover",
            timestamp: Date.now(),
          });
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!isDragOver) {
            setIsDragOver(true);
            dispatch({ type: "HOVER_DROP" });
          }
        }}
        onDragLeave={() => {
          setIsDragOver(false);
          dispatch({ type: "RESET" });
        }}
        onDrop={async (event) => {
          event.preventDefault();
          setIsDragOver(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) {
            const path = (files[0] as unknown as { path: string }).path;
            if (path) {
              handleHumanInteraction({
                type: "drop_file",
                timestamp: Date.now(),
                payload: {
                  fileCount: files.length,
                  fileName: files[0]?.name,
                },
              });
              void runCommand("prepare_text_attachment", { path });
            }
          } else {
            const url = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
            if (url) {
              handleHumanInteraction({
                type: "drop_text",
                timestamp: Date.now(),
                payload: {
                  message: url,
                },
              });
              void runCommand("show_bubble");
            }
          }
        }}
        onMouseMove={(event) => {
          const rect = petRef.current?.getBoundingClientRect();
          if (!rect) return;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const dx = Math.max(-0.5, Math.min(0.5, (event.clientX - cx) / rect.width));
          const dy = Math.max(-0.5, Math.min(0.5, (event.clientY - cy) / rect.height));
          setMouseDelta({ x: dx, y: dy });
        }}
        onMouseLeave={() => setMouseDelta({ x: 0, y: 0 })}
        onDoubleClick={(event) => {
          event.stopPropagation();
          handleHumanInteraction({
            type: "double_click",
            timestamp: Date.now(),
          });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <PetSprite
          mode={petState.mode}
          emotion={petState.emotion}
          reaction={petState.reaction}
          mouseDelta={mouseDelta}
        />
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
            handleHumanInteraction({
              type: "chat_open",
              timestamp: Date.now(),
            });
          }}
        >
          对话
        </button>
        <button className="icon-button" type="button" onClick={() => runCommand("open_panel")}>
          面板
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => handleHumanInteraction({
            type: isResting ? "user_idle_ended" : "user_idle_started",
            timestamp: Date.now(),
          })}
        >
          {isResting ? "唤醒" : "休息"}
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            if (petVisualStyle === "character") {
              const nextModelId = getNextLive2DModelId(live2dModelId);
              const nextModelLabel = live2dModelOptions.find((option) => option.value === nextModelId)?.label ?? "官方模型";
              setLive2DModelId(nextModelId);
              showPetNotice(`已切换到 ${nextModelLabel}`);
            } else {
              setLive2DModelId(defaultLive2DModelId);
              setPetVisualStyle("character");
              const modelLabel = live2dModelOptions.find((option) => option.value === defaultLive2DModelId)?.label ?? "官方模型";
              showPetNotice(`已切换到 ${modelLabel}`);
            }
          }}
        >
          {petVisualStyle === "character" ? "换模型" : "官方"}
        </button>
      </div>
      {contextMenu && (
        <div
          className="pet-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              runCommand("show_bubble");
              setContextMenu(null);
            }}
          >
            对话
          </button>
          <button
            type="button"
            onClick={() => {
              runCommand("open_panel");
              setContextMenu(null);
            }}
          >
            面板
          </button>
          <button
            type="button"
            onClick={() => {
              dispatch({ type: isResting ? "WAKE" : "REST" });
              setContextMenu(null);
            }}
          >
            {isResting ? "唤醒" : "休息"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPetVisualStyle(getNextPetVisualStyle(petVisualStyle));
              setContextMenu(null);
            }}
          >
            切换形象
          </button>
          <button
            type="button"
            onClick={() => {
              runCommand("hide_pet");
              setContextMenu(null);
            }}
          >
            隐藏
          </button>
        </div>
      )}
    </main>
  );
}

export function PetWindow() {
  return (
    <PetDomainProvider>
      <PetWindowContent />
    </PetDomainProvider>
  );
}
