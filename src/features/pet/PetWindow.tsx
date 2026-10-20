import { useStableEvent } from "../../hooks/useStableEvent";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AppSettings, PetVisualEvent, QuietMode, Theme } from "../../types/appTypes";
import {
  PetSprite,
  defaultAppSettings,
  usePetVisualStyle,
} from "../app/appShared";
import { runCommand } from "../app/appRuntime";
import { reportSoulActivity, currentActivitySnapshot, ACTIVITY_HEARTBEAT_SECONDS } from "../soul/proactiveBridge";
import { initialPetState, reducePetState } from "./petState";
import { moodExpression, type SoulMood } from "../soul/moodPresentation";
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
import { usePetClickThrough } from "./hooks/usePetClickThrough";
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
        attentionPulseAfterSeconds: 300,
        attentionPulseIntervalMs: 60000,
      };
    case "lively":
      return {
        fidgetDelayMin: 7000,
        fidgetDelayMax: 15000,
        fidgetResetDelay: 1400,
        attentionPulseAfterSeconds: 180,
        attentionPulseIntervalMs: 60000,
      };
    default:
      return {
        fidgetDelayMin: 11000,
        fidgetDelayMax: 20000,
        fidgetResetDelay: 1300,
        attentionPulseAfterSeconds: 300,
        attentionPulseIntervalMs: 60000,
      };
  }
}

function PetWindowContent() {
  useEffect(()=>{
    reportSoulActivity(currentActivitySnapshot(false));
    const timer=window.setInterval(()=>reportSoulActivity(currentActivitySnapshot(false)),ACTIVITY_HEARTBEAT_SECONDS*1000);
    return ()=>window.clearInterval(timer);
  },[]);
  const [petState, dispatch] = useReducer(reducePetState, initialPetState);
  const [soulMood, setSoulMood] = useState<SoulMood>("calm");
  useEffect(() => {
    let disposed = false;
    const refresh = () => void runCommand<SoulMood>("soul_get_mood").then((mood) => {
      if (!disposed) setSoulMood(mood);
    }).catch(() => { if (!disposed) setSoulMood("calm"); });
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  useTauriEventSubscription("soul:changed", () => {
    void runCommand<SoulMood>("soul_get_mood").then(setSoulMood).catch(() => setSoulMood("calm"));
  });

  const [companionName, setCompanionName] = useState("Piko");
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [sensingPaused, setSensingPaused] = useState(false);
  const [theme, setTheme] = useState<Theme>("sage");
  const isResting = petState.mode === "resting";
  const resetTimer = useRef<number | undefined>(undefined);
  const [mouseDelta, setMouseDelta] = useState({ x: 0, y: 0 });
  const [isDragOver, setIsDragOver] = useState(false);
  const petRef = useRef<HTMLDivElement>(null);
  const [attentionPulse, setAttentionPulse] = useState(false);
  const idleStartRef = useRef(0);
  const [pulseMode, setPulseMode] = useState(petState.mode);
  if (pulseMode !== petState.mode) { setPulseMode(petState.mode); setAttentionPulse(false); }
  const petVisualStyle = usePetVisualStyle();
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

  const handleDragEnd = useStableEvent((distance: number) => handleHumanInteraction({ type: "drag_end", timestamp: Date.now(), payload: { distancePx: distance } }));
  const handleStroke = useStableEvent((distance: number, duration: number) => handleHumanInteraction({ type: "pet_stroke", timestamp: Date.now(), intensity: Math.min(1, distance / 120), payload: { durationMs: duration, distancePx: distance } }));
  const handleClick = useStableEvent(() => handleHumanInteraction({ type: "click", timestamp: Date.now() }));
  const { isDragging, isLongPressing, handlers: dragHandlers } = usePetDrag({ onDragEnd: handleDragEnd, onStroke: handleStroke, onClick: handleClick });

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
      // Explicit user intent opens/focuses chat; only the chat's own controls hide it.
      void runCommand("show_bubble");
    } else if (event.type === "click") {
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

  const scheduleFidget = useStableEvent(() => {
    const delay = idleRhythm.fidgetDelayMin + Math.random() * (idleRhythm.fidgetDelayMax - idleRhythm.fidgetDelayMin);
    let reset: number | undefined;
    const timer = window.setTimeout(() => {
      dispatch({ type: "FIDGET", intensity: motionStyle === "soft" ? "soft" : "normal" });
      reset = window.setTimeout(() => { dispatch({ type: "RESET" }); }, idleRhythm.fidgetResetDelay);
    }, delay);
    return () => { window.clearTimeout(timer); window.clearTimeout(reset); };
  });

  useEffect(() => {
    if (petState.mode === "idle") {
      idleStartRef.current = Date.now();
    }
  }, [petState.mode, quietMode, motionStyle]);

  useEffect(() => {
    if (petState.mode !== "idle" || quietMode === "minimal") {
      return;
    }
    let pulseTimer: number | undefined;
    const interval = window.setInterval(() => {
      const idleSeconds = (Date.now() - idleStartRef.current) / 1000;
      if (idleSeconds > idleRhythm.attentionPulseAfterSeconds) {
        setAttentionPulse(true);
        idleStartRef.current = Date.now();
        pulseTimer = window.setTimeout(() => setAttentionPulse(false), 1600);
      } else {
        setAttentionPulse(false);
      }
    }, idleRhythm.attentionPulseIntervalMs);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(pulseTimer);
    };
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
  }, [personalityManager]);

  useEffect(() => () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (behaviorNoticeTimer.current) window.clearTimeout(behaviorNoticeTimer.current);
  }, []);

  useEffect(() => {
    if (petState.mode === "idle" && quietMode !== "minimal") {
      return scheduleFidget();
    }
  }, [petState.mode, quietMode, idleRhythm, scheduleFidget]);

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
        // Idle motion is decorative and must not produce unsolicited audio.
        case "idle_fidget": break;
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

  const clickThroughHandlers = usePetClickThrough();

  return (
    <main
      className={`pet-stage pet-stage--${theme} pet-stage--${quietMode}${sensingPaused ? " is-sensing-paused" : ""}`}
      aria-label={`桌面精灵 ${companionName}`}
      {...clickThroughHandlers}
    >
      {petNotice && (
        <button
          className="pet-notice-bubble"
          type="button"
          data-pet-interactive
          onPointerDown={(event) => event.stopPropagation()}
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
        {...dragHandlers}
        data-pet-interactive
        ref={petRef}
        className={`pet pet--${petVisualStyle} pet--${petState.mode} pet--bond-${bondTier} pet-reaction--${petState.reaction}${isDragOver ? " is-drag-over" : ""}${isDragging ? " is-dragging" : ""}${isLongPressing ? " is-long-pressing" : ""}${attentionPulse && petState.mode === "idle" && quietMode !== "minimal" ? " is-attention-pulse" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="打开 Piko 对话（可拖动）"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void runCommand("show_bubble");
          }
        }}
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
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void runCommand("show_pet_context_menu");
        }}
      >
        <PetSprite
          mode={petState.mode}
          emotion={moodExpression(soulMood, petState.mode, petState.reaction, petState.emotion)}
          reaction={petState.reaction}
          mouseDelta={mouseDelta}
        />
      </div>
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
