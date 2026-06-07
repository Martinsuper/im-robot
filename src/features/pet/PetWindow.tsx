import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, PetVisualEvent, QuietMode, Theme } from "../../types/appTypes";
import {
  PetSprite,
  defaultAppSettings,
  getNextPetVisualStyle,
  setPetVisualStyle,
  useCurrentTime,
  usePetVisualStyle,
} from "../app/appShared";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { initialPetState, reducePetState } from "./petState";
import { setBubbleCompanionMessage } from "../chat/bubbleMessage";
import type { ChatEvent } from "../chat/chatTypes";
import * as audio from "./petAudio";
import {
  BehaviorSystem,
  PersonalityManager,
  describePersonality,
  derivePersonalityFromSignals,
  loadPersonalityState,
  recordPersonalitySignalFromInteraction,
  savePersonalityState,
  type PersonalityDimensions,
} from "./personality";
import {
  InteractionManager,
  applyInteractionGrowth,
  loadGrowthSnapshot,
  loadInteractionStats,
  getPetSpeechFallbackForInteraction,
  getPetSpeechForInteraction,
  type PetBehaviorProfile,
  type PetBehaviorPriority,
  resolvePetBehaviorPriority,
  resolvePetBehaviorProfile,
  resolvePetIdleMotionStyle,
  storeInteractionStats,
  type GrowthSnapshot,
  type HumanInteractionEvent,
  type InteractionStats,
  type PetMotionStyle,
} from "./interaction";

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

function getBondTier(snapshot: GrowthSnapshot) {
  if (snapshot.level >= 12 || snapshot.attributeLevels.bond >= 8 || snapshot.intimacy >= 55) return "close";
  if (snapshot.level >= 6 || snapshot.attributeLevels.bond >= 4 || snapshot.intimacy >= 25) return "trusted";
  if (snapshot.level >= 3 || snapshot.attributeLevels.bond >= 2 || snapshot.intimacy >= 10) return "warm";
  return "new";
}

function getBondLabel(tier: ReturnType<typeof getBondTier>) {
  switch (tier) {
    case "warm":
      return "熟悉";
    case "trusted":
      return "默契";
    case "close":
      return "亲近";
    default:
      return "初识";
  }
}

function getBondLine(tier: ReturnType<typeof getBondTier>) {
  switch (tier) {
    case "warm":
      return "Piko 开始记住你的节奏了。";
    case "trusted":
      return "Piko 和你已经很合拍。";
    case "close":
      return "Piko 会主动靠近你一点。";
    default:
      return "Piko 还在悄悄认识你。";
  }
}

type BondTier = ReturnType<typeof getBondTier>;

interface IdleRhythmProfile {
  fidgetDelayMin: number;
  fidgetDelayMax: number;
  fidgetResetDelay: number;
  wanderDelayMin: number;
  wanderDelayMax: number;
  wanderDistanceMin: number;
  wanderDistanceMax: number;
  wanderStepsMin: number;
  wanderStepsMax: number;
  attentionPulseAfterSeconds: number;
  attentionPulseIntervalMs: number;
}

function getFallbackMotionStyleForBond(tier: BondTier): PetMotionStyle {
  if (tier === "close" || tier === "trusted") return "soft";
  if (tier === "warm") return "balanced";
  return "lively";
}

function getFallbackBehaviorProfileForBond(tier: BondTier): PetBehaviorProfile {
  if (tier === "close") return "calm";
  if (tier === "trusted") return "balanced";
  if (tier === "warm") return "curious";
  return "playful";
}

function getFallbackBehaviorPriorityForBond(tier: BondTier): PetBehaviorPriority {
  if (tier === "close") return ["calm", "focused", "curious", "balanced", "playful", "neutral"];
  if (tier === "trusted") return ["balanced", "curious", "focused", "playful", "calm", "neutral"];
  if (tier === "warm") return ["curious", "playful", "balanced", "focused", "calm", "neutral"];
  return ["playful", "curious", "balanced", "focused", "calm", "neutral"];
}

function getIdleRhythmProfile(style: PetMotionStyle): IdleRhythmProfile {
  switch (style) {
    case "soft":
      return {
        fidgetDelayMin: 17000,
        fidgetDelayMax: 30000,
        fidgetResetDelay: 1100,
        wanderDelayMin: 10000,
        wanderDelayMax: 22000,
        wanderDistanceMin: 18,
        wanderDistanceMax: 36,
        wanderStepsMin: 8,
        wanderStepsMax: 14,
        attentionPulseAfterSeconds: 20,
        attentionPulseIntervalMs: 6500,
      };
    case "lively":
      return {
        fidgetDelayMin: 7000,
        fidgetDelayMax: 15000,
        fidgetResetDelay: 1400,
        wanderDelayMin: 4500,
        wanderDelayMax: 12000,
        wanderDistanceMin: 44,
        wanderDistanceMax: 112,
        wanderStepsMin: 6,
        wanderStepsMax: 11,
        attentionPulseAfterSeconds: 10,
        attentionPulseIntervalMs: 3500,
      };
    default:
      return {
        fidgetDelayMin: 11000,
        fidgetDelayMax: 20000,
        fidgetResetDelay: 1300,
        wanderDelayMin: 7000,
        wanderDelayMax: 15000,
        wanderDistanceMin: 34,
        wanderDistanceMax: 68,
        wanderStepsMin: 6,
        wanderStepsMax: 10,
        attentionPulseAfterSeconds: 15,
        attentionPulseIntervalMs: 5000,
      };
  }
}

export function PetWindow() {
  const [petState, dispatch] = useReducer(reducePetState, initialPetState);
  const [companionName, setCompanionName] = useState("Piko");
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [sensingPaused, setSensingPaused] = useState(false);
  const [theme, setTheme] = useState<Theme>("sage");
  const [petNotice, setPetNotice] = useState("");
  const currentTime = useCurrentTime();
  const isResting = petState.mode === "resting";
  const resetTimer = useRef<number | undefined>(undefined);
  const [mouseDelta, setMouseDelta] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fidgetTimer = useRef<number>(0);
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const didDrag = useRef(false);
  const dragSamples = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const inertiaFrame = useRef<number>(0);
  const longPressTimer = useRef<number>(0);
  const longPressTriggered = useRef(false);
  const petRef = useRef<HTMLDivElement>(null);
  const wanderTimer = useRef<number>(0);
  const [attentionPulse, setAttentionPulse] = useState(false);
  const idleStartRef = useRef(Date.now());
  const petVisualStyle = usePetVisualStyle();
  const interactionManagerRef = useRef<InteractionManager | null>(null);
  const interactionStatsRef = useRef<InteractionStats | null>(null);
  const [growthSnapshot, setGrowthSnapshot] = useState<GrowthSnapshot>(loadGrowthSnapshot());
  const [motionStyle, setMotionStyle] = useState<PetMotionStyle>(getFallbackMotionStyleForBond(getBondTier(loadGrowthSnapshot())));
  const [behaviorProfile, setBehaviorProfile] = useState(() => getFallbackBehaviorProfileForBond(getBondTier(loadGrowthSnapshot())));
  const [behaviorPriority, setBehaviorPriority] = useState<PetBehaviorPriority>(() => getFallbackBehaviorPriorityForBond(getBondTier(loadGrowthSnapshot())));
  const [aiRevision, setAiRevision] = useState(0);
  const [personalitySnapshot, setPersonalitySnapshot] = useState<PersonalityDimensions>(() =>
    loadPersonalityState(derivePersonalityFromSignals(loadInteractionStats(), loadGrowthSnapshot()))
  );
  const suppressClickRef = useRef(false);
  const noticeTimer = useRef<number>(0);
  const noticeRequestSeq = useRef(0);
  const behaviorNoticeTimer = useRef<number>(0);
  const bondTier = getBondTier(growthSnapshot);
  const idleRhythm = useMemo(() => getIdleRhythmProfile(motionStyle), [motionStyle]);
  const personalityManagerRef = useRef<PersonalityManager | null>(null);
  const behaviorSystemRef = useRef<BehaviorSystem | null>(null);
  const currentPersonality = personalitySnapshot;
  const personalitySummary = useMemo(() => describePersonality(currentPersonality), [currentPersonality]);

  const petPos = useRef({ x: 0, y: 0 });
  const posReady = useRef(false);
  const motionStyleRequestSeq = useRef(0);
  const behaviorProfileRequestSeq = useRef(0);
  const behaviorPriorityRequestSeq = useRef(0);
  const bubbleMessageRequestSeq = useRef(0);

  if (!interactionManagerRef.current) {
    interactionManagerRef.current = new InteractionManager();
  }
  if (!interactionStatsRef.current) {
    interactionStatsRef.current = loadInteractionStats();
  }
  if (!personalityManagerRef.current) {
    personalityManagerRef.current = new PersonalityManager(currentPersonality);
    savePersonalityState(personalityManagerRef.current.getState());
  }
  if (!behaviorSystemRef.current && personalityManagerRef.current) {
    behaviorSystemRef.current = new BehaviorSystem(personalityManagerRef.current, () => undefined);
  }

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

  function handleHumanInteraction(event: HumanInteractionEvent) {
    const result = interactionManagerRef.current!.handle(event, {
      quietMode,
      petMode: petState.mode,
      petEmotion: petState.emotion,
      isResting,
      recentInteractionCount: interactionStatsRef.current?.totalInteractions ?? 0,
      lastInteractionAt: interactionStatsRef.current?.lastInteractionAt ?? undefined,
      intimacy: interactionStatsRef.current?.intimacy ?? 0,
      energy: 1,
    });

    if (result.saveStats) {
      const nextStats = storeInteractionStats(event);
      interactionStatsRef.current = nextStats;
      const nextGrowth = applyInteractionGrowth(event);
      setGrowthSnapshot(nextGrowth);
    }

    const personalitySignal = recordPersonalitySignalFromInteraction(event);
    if (personalitySignal) {
      personalityManagerRef.current?.recordInteraction(personalitySignal);
    }
    behaviorSystemRef.current?.evaluateNow();

    const livePersonality = personalityManagerRef.current?.getState() ?? currentPersonality;

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
      const requestSeq = ++bubbleMessageRequestSeq.current;
      setBubbleCompanionMessage(getPetSpeechFallbackForInteraction(event.type, bondTier));
      void getPetSpeechForInteraction(event.type, bondTier, livePersonality, describePersonality(livePersonality)).then((message) => {
        if (requestSeq !== bubbleMessageRequestSeq.current) return;
        setBubbleCompanionMessage(message);
      });
      void runCommand("show_bubble");
    }

    if (result.openPanel) {
      void runCommand("open_panel");
    }
  }

  useEffect(() => {
    if (!isTauriRuntime) return;
    runCommand<[number, number]>("get_pet_position", undefined, [0, 0]).then(([x, y]) => {
      petPos.current = { x, y };
      posReady.current = true;
    });
  }, []);

  useEffect(() => {
    const manager = personalityManagerRef.current;
    if (!manager) return;

    const unsubscribe = manager.onChange(() => {
      const nextState = manager.getState();
      setPersonalitySnapshot(nextState);
      savePersonalityState(nextState);
      behaviorSystemRef.current?.evaluateNow();
    });

    const currentState = manager.getState();
    setPersonalitySnapshot(currentState);
    savePersonalityState(currentState);

    return unsubscribe;
  }, []);

  useEffect(() => {
    const behaviorSystem = behaviorSystemRef.current;
    if (!behaviorSystem) return;

    behaviorSystem.setOnTrigger((behavior) => {
      if (quietMode === "minimal") return;

      if (behavior.petEvent) {
        dispatch(behavior.petEvent);
      }

      if (behavior.message) {
        if (behaviorNoticeTimer.current) window.clearTimeout(behaviorNoticeTimer.current);
        setPetNotice(behavior.message);
        behaviorNoticeTimer.current = window.setTimeout(() => {
          setPetNotice("");
        }, 2200);
      }
    });

    behaviorSystem.start();
    return () => {
      behaviorSystem.stop();
      if (behaviorNoticeTimer.current) window.clearTimeout(behaviorNoticeTimer.current);
    };
  }, [quietMode]);

  useEffect(() => {
    const fallbackStyle = getFallbackMotionStyleForBond(bondTier);
    setMotionStyle(fallbackStyle);

    const requestSeq = ++motionStyleRequestSeq.current;
    void resolvePetIdleMotionStyle({
      bondTier,
      personality: currentPersonality,
      personalitySummary,
    }).then((resolvedStyle) => {
      if (requestSeq !== motionStyleRequestSeq.current) return;
      if (resolvedStyle) {
        setMotionStyle(resolvedStyle);
      }
    });
  }, [bondTier, aiRevision, currentPersonality, personalitySummary]);

  useEffect(() => {
    const fallbackBehaviorProfile = getFallbackBehaviorProfileForBond(bondTier);
    setBehaviorProfile(fallbackBehaviorProfile);

    const requestSeq = ++behaviorProfileRequestSeq.current;
    void resolvePetBehaviorProfile({
      bondTier,
      personality: currentPersonality,
      personalitySummary,
    }).then((resolvedProfile) => {
      if (requestSeq !== behaviorProfileRequestSeq.current) return;
      if (resolvedProfile) {
        setBehaviorProfile(resolvedProfile);
      }
    });
  }, [bondTier, aiRevision, currentPersonality, personalitySummary]);

  useEffect(() => {
    const behaviorSystem = behaviorSystemRef.current;
    if (!behaviorSystem) return;
    behaviorSystem.setBehaviorProfile(behaviorProfile);
    behaviorSystem.evaluateNow();
  }, [behaviorProfile]);

  useEffect(() => {
    const fallbackBehaviorPriority = getFallbackBehaviorPriorityForBond(bondTier);
    setBehaviorPriority(fallbackBehaviorPriority);

    const requestSeq = ++behaviorPriorityRequestSeq.current;
    void resolvePetBehaviorPriority({
      bondTier,
      personality: currentPersonality,
      personalitySummary,
    }).then((resolvedPriority) => {
      if (requestSeq !== behaviorPriorityRequestSeq.current) return;
      if (resolvedPriority?.length) {
        setBehaviorPriority(resolvedPriority);
      }
    });
  }, [bondTier, aiRevision, currentPersonality, personalitySummary]);

  useEffect(() => {
    const behaviorSystem = behaviorSystemRef.current;
    if (!behaviorSystem) return;
    behaviorSystem.setBehaviorPriority(behaviorPriority);
    behaviorSystem.evaluateNow();
  }, [behaviorPriority]);

  function resetAfter(delay = 1400) {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => dispatch({ type: "RESET" }), delay);
  }

  function showTransient(event: Parameters<typeof dispatch>[0], delay?: number) {
    dispatch(event);
    resetAfter(delay);
  }

  function showCompanionNotice(
    eventType: string,
    fallbackMessage: string,
    durationMs = 2600
  ) {
    const livePersonality = personalityManagerRef.current?.getState() ?? currentPersonality;
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    const requestSeq = ++noticeRequestSeq.current;
    setPetNotice(fallbackMessage);
    noticeTimer.current = window.setTimeout(() => {
      if (requestSeq === noticeRequestSeq.current) {
        setPetNotice("");
      }
    }, durationMs);

    void getPetSpeechForInteraction(eventType, bondTier, livePersonality, describePersonality(livePersonality)).then((message) => {
      if (requestSeq !== noticeRequestSeq.current) return;
      setPetNotice(message);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => {
        if (requestSeq === noticeRequestSeq.current) {
          setPetNotice("");
        }
      }, durationMs);
    });
  }

  function scheduleFidget() {
    const delay = idleRhythm.fidgetDelayMin + Math.random() * (idleRhythm.fidgetDelayMax - idleRhythm.fidgetDelayMin);
    fidgetTimer.current = window.setTimeout(() => {
      if (petState.mode === "idle") {
        dispatch({
          type: "FIDGET",
          intensity: motionStyle === "soft" ? "soft" : "normal",
        });
        setTimeout(() => {
          if (petState.mode === "idle") dispatch({ type: "RESET" });
        }, idleRhythm.fidgetResetDelay);
      }
      scheduleFidget();
    }, delay);
  }

  function scheduleWander() {
    const wanderDelay = idleRhythm.wanderDelayMin + Math.random() * (idleRhythm.wanderDelayMax - idleRhythm.wanderDelayMin);
    wanderTimer.current = window.setTimeout(() => {
      if (petState.mode !== "idle" || quietMode === "minimal" || !posReady.current) {
        scheduleWander();
        return;
      }
      const distance = idleRhythm.wanderDistanceMin + Math.random() * (idleRhythm.wanderDistanceMax - idleRhythm.wanderDistanceMin);
      const angle = Math.random() * Math.PI * 2;
      const totalDx = Math.round(Math.cos(angle) * distance);
      const totalDy = Math.round(Math.sin(angle) * distance);
      if (totalDx === 0 && totalDy === 0) { scheduleWander(); return; }
      const totalSteps = idleRhythm.wanderStepsMin + Math.floor(Math.random() * (idleRhythm.wanderStepsMax - idleRhythm.wanderStepsMin + 1));
      let step = 0;

      function doStep() {
        if (petState.mode !== "idle") { scheduleWander(); return; }
        step++;
        if (step > totalSteps) { scheduleWander(); return; }
        movePetBy(
          Math.round(totalDx / totalSteps),
          Math.round(totalDy / totalSteps)
        );
        requestAnimationFrame(doStep);
      }
      requestAnimationFrame(doStep);
    }, wanderDelay);
  }

  useEffect(() => {
    if (petState.mode === "idle") {
      idleStartRef.current = Date.now();
      scheduleWander();
    } else {
      if (wanderTimer.current) window.clearTimeout(wanderTimer.current);
      setAttentionPulse(false);
    }
    return () => {
      if (wanderTimer.current) window.clearTimeout(wanderTimer.current);
    };
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

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.type === "started") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: event.payload.working ? "focus_started" : "chat_submitted" })
          ?? { type: event.payload.working ? "work" : "chat", timestamp: Date.now(), intensity: 0.5 }
        );
        dispatch({ type: event.payload.working ? "WORK_STARTED" : "CHAT_SUBMITTED" });
      }
      if (event.payload.type === "delta") {
        dispatch({ type: "CHAT_STREAM_STARTED" });
      }
      if (event.payload.type === "completed") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "chat_completed" })
            ?? { type: "celebrate", timestamp: Date.now(), intensity: 0.8 }
        );
        showTransient({ type: "CHAT_COMPLETED" });
      }
      if (event.payload.type === "cancelled") dispatch({ type: "RESET" });
      if (event.payload.type === "failed") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "FAILED" })
            ?? { type: "work", timestamp: Date.now(), intensity: 0.8 }
        );
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
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "break_reminder" })
            ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
        );
        dispatch({ type: "REMINDER_FIRED", message: event.payload.message });
        showCompanionNotice("break_reminder", event.payload.message, 3600);
      }
      if (event.payload.type === "calendar-event-due") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "break_reminder" })
            ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
        );
        dispatch({ type: "REMINDER_FIRED", message: event.payload.message });
        showCompanionNotice("break_reminder", event.payload.message, 3600);
      }
      if (event.payload.type === "ambient-nudge") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "ambient_nudge" })
            ?? { type: "idle", timestamp: Date.now(), intensity: 0.5 }
        );
        showTransient({ type: "AMBIENT_NUDGE" }, 1800);
        showCompanionNotice("ambient_nudge", "Piko 轻轻看了你一眼。", 2400);
      }
      if (event.payload.type === "break-reminder") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "break_reminder" })
            ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
        );
        dispatch({ type: "BREAK_REMINDER", message: event.payload.message });
        showCompanionNotice("break_reminder", event.payload.message, 4200);
      }
      if (event.payload.type === "idle-started") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "user_idle_started" })
            ?? { type: "idle", timestamp: Date.now(), intensity: 1 }
        );
        dispatch({ type: "REST" });
        showCompanionNotice("user_idle_started", "Piko 安静下来陪你休息。", 2800);
      }
      if (event.payload.type === "idle-ended") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "user_idle_ended" })
            ?? { type: "idle", timestamp: Date.now(), intensity: 0.2 }
        );
        showTransient({ type: "WAKE" }, 1800);
        showCompanionNotice("user_idle_ended", "欢迎回来。", 2800);
      }
      if (event.payload.type === "focus-started") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "focus_started" })
            ?? { type: "work", timestamp: Date.now(), intensity: 0.7 }
        );
        dispatch({ type: "WORK_STARTED" });
        showCompanionNotice("focus_started", "Piko 正在放轻脚步。", 2200);
      }
      if (event.payload.type === "focus-completed") {
        personalityManagerRef.current?.recordInteraction(
          recordPersonalitySignalFromInteraction({ type: "focus_completed" })
            ?? { type: "celebrate", timestamp: Date.now(), intensity: 0.8 }
        );
        showTransient({ type: "CHAT_COMPLETED" }, 2600);
        showCompanionNotice("focus_completed", "做完啦，来看看结果。", 3200);
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
      setAiRevision((current) => current + 1);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const refreshProfile = () => {
      interactionStatsRef.current = loadInteractionStats();
      const loadedPersonality = loadPersonalityState(
        personalityManagerRef.current?.getState() ?? currentPersonality
      );
      personalityManagerRef.current?.setState(loadedPersonality);
      setPersonalitySnapshot(loadedPersonality);
      setGrowthSnapshot(loadGrowthSnapshot());
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
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (behaviorNoticeTimer.current) window.clearTimeout(behaviorNoticeTimer.current);
    stopInertia();
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
      scheduleFidget();
    } else {
      if (fidgetTimer.current) window.clearTimeout(fidgetTimer.current);
    }
    return () => {
      if (fidgetTimer.current) window.clearTimeout(fidgetTimer.current);
    };
  }, [petState.mode, quietMode, idleRhythm]);

  const prevReaction = useRef(petState.reaction);
  const prevEmotion = useRef(petState.emotion);
  const bondLabel = getBondLabel(bondTier);
  const bondLine = getBondLine(bondTier);

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
      onMouseDown={(event) => {
        if (!isTauriRuntime || event.button !== 0) return;
        stopInertia();
        didDrag.current = false;
        longPressTriggered.current = false;
        suppressClickRef.current = false;
        dragSamples.current = [{ x: event.screenX, y: event.screenY, t: performance.now() }];
        longPressTimer.current = window.setTimeout(() => {
          if (!didDrag.current) {
            longPressTriggered.current = true;
            setContextMenu({ x: event.clientX, y: event.clientY });
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
      }}
      onMouseUp={() => {
        if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
        if (didDrag.current) {
          startInertia();
          handleHumanInteraction({
            type: "drag_end",
            timestamp: Date.now(),
            payload: {
              distancePx: pathDistance(dragSamples.current),
            },
          });
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
            handleHumanInteraction({
              type: "pet_stroke",
              timestamp: Date.now(),
              intensity: Math.min(1, totalDistance / 120),
              payload: {
                durationMs,
                distancePx: totalDistance,
              },
            });
          } else {
            handleHumanInteraction({
              type: "click",
              timestamp: Date.now(),
            });
          }
          suppressClickRef.current = true;
        }
        setIsDragging(false);
        setDragOrigin(null);
        dragSamples.current = [];
      }}
      onMouseMove={(event) => {
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
        }}
    >
      {petNotice && (
        <button
          className="pet-notice-bubble"
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setPetNotice("");
          }}
          aria-label="关闭提醒"
        >
          {petNotice}
        </button>
      )}
      <div
        ref={petRef}
        className={`pet pet--${petState.mode} pet--bond-${bondTier} pet-reaction--${petState.reaction}${isDragOver ? " is-drag-over" : ""}${isDragging ? " is-dragging" : ""}${attentionPulse ? " is-attention-pulse" : ""}`}
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
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
        }}
      >
        <PetSprite
          mode={petState.mode}
          emotion={petState.emotion}
          reaction={petState.reaction}
          mouseDelta={mouseDelta}
        />
        {bondTier !== "new" && (
          <span className="pet-bond-badge" aria-hidden="true">
            {bondLabel}
          </span>
        )}
        <span className="pet-rapport" aria-hidden="true">
          {bondLine}
        </span>
        <time className="pet-clock" aria-label={`当前时间 ${currentTime}`}>
          {currentTime}
        </time>
        <span className={`pet-emotion pet-emotion--${petState.emotion}`} aria-hidden="true" />
      </div>
      {personalitySummary && bondTier !== "new" && (
        <p className="pet-personality-note" aria-hidden="true">
          {personalitySummary}
        </p>
      )}
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
      <p className="pet-status" aria-live="polite">
        {petState.message}
      </p>
    </main>
  );
}
