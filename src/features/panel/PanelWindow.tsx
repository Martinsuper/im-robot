import { PanelHistory, formatChatHistoryTime } from "./PanelHistory";
import { CompanionHero, PanelHeader, PanelNavigation } from "./PanelChrome";
import { version as appVersion } from "../../../package.json";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { OnboardingWindow } from "../onboarding/OnboardingWindow";
import { MemoryCenter } from "../memory/MemoryCenter";
import { ErrorState } from "../../components/feedback/States";
import { useToast, type ToastTone } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";
import { useAutoSave } from "../../hooks/useAutoSave";
import {
  defaultPreferencesDraft,
  defaultWorkRhythmDraft,
  isWorkRhythmDraftValid,
  toPreferencesDraft,
  toWorkRhythmDraft,
  type PreferencesDraft,
  type WorkRhythmDraft,
} from "./settingsDrafts";
import {
  loadGrowthSnapshot,
  loadInteractionStats,
  type GrowthSnapshot,
  type InteractionStats,
} from "../pet/interaction";
import type {
  AiSettings,
  AppSettings,
  CalendarEvent,
  CalendarSyncStatus,
  ChatHistoryEntry,
  FocusSnapshot,
  InstalledPlugin,
  Memo,
  MemoCategory,
  MemoSummaryGroup,
  ModelInfo,
  OnboardingStatus,
  PanelTab,
  QuietMode,
  Reminder,
  ReminderRepeat,
  SpeechModelDownloadProgress,
  SpeechModelStatus,
  Theme,
  UpdateStatus,
  WorkRhythmState,
} from "../../types/appTypes";
import {
  clearCustomPetImagePath,
  countCalendarConflicts,
  defaultAiSettings,
  defaultAppSettings,
  defaultCalendarEndTime,
  defaultCalendarStartTime,
  defaultFocusSnapshot,
  defaultReminderTime,
  defaultWorkRhythmState,
  formatDuration,
  formatBytes,
  formatCalendarRange,
  formatFocusRemaining,
  formatReminderTime,
  getAvailablePetVisualStyleOptions,
  petVisualStyleOptions,
  providerOptions,
  quietModeOptions,
  reminderRepeatLabel,
  reminderRepeatOptions,
  setCustomPetImagePath,
  setPetVisualStyle,
  useCustomPetImagePath,
  usePetVisualStyle,
} from "../app/appShared";
import { isTauriRuntime, runCommand, runCommandAndRefresh } from "../app/appRuntime";


const memoCategoryLabels: Record<MemoCategory, string> = {
  task: "任务",
  idea: "想法",
  learning: "学习",
  work: "工作",
  life: "生活",
  reference: "资料",
  other: "其他",
};

const memoCategoryOptions: Array<{ label: string; value: MemoCategory | "all" }> = [
  { label: "全部", value: "all" },
  { label: "任务", value: "task" },
  { label: "想法", value: "idea" },
  { label: "学习", value: "learning" },
  { label: "工作", value: "work" },
  { label: "生活", value: "life" },
  { label: "资料", value: "reference" },
  { label: "其他", value: "other" },
];

/**
 * 瞬时状态文案 → Toast 语气。
 * Why 用关键字集中判断，而不是让 20 个写入点各自选 tone：逐处改造既容易漏，
 * 也会把语气逻辑撒满整个文件。
 */
function toneFromStatus(text: string, fallback: ToastTone = "info"): ToastTone {
  if (/失败|错误|异常|无法/.test(text)) return "error";
  if (/已保存|已同步|已可用|已是最新|下载完成|已更新|已配置/.test(text)) return "success";
  return fallback;
}

export function PanelWindow() {
  const mountedRef = useRef(true);
  const toast = useToast();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("companion");

  /** 切 Tab 时把内容区回到顶部：面板只渲染当前 Tab，但滚动位置会保留在同一个滚动容器上。 */
  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [panelTab]);
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [aiSettings, setAiSettings] = useState<AiSettings>(defaultAiSettings);
  const autoSave = useAutoSave();
  // 偏好与休息提醒改为「草稿 + 已保存基线」两个来源：
  // 只有服务端返回值会更新基线，用户改动只动草稿，自动保存因此不会误判。
  const [preferences, setPreferences] = useState<PreferencesDraft>(defaultPreferencesDraft);
  const preferencesRef = useRef(preferences);
  const savedPreferencesRef = useRef(preferences);
  const { companionName, theme, sensingPaused } = preferences;
  const petVisualStyle = usePetVisualStyle();
  const customPetImagePath = useCustomPetImagePath();
  const availablePetVisualStyleOptions = getAvailablePetVisualStyleOptions(Boolean(customPetImagePath));
  const petVisualStyleLabel = petVisualStyleOptions.find((option) => option.value === petVisualStyle)?.label ?? "机甲猫";
  const [workRhythm, setWorkRhythm] = useState<WorkRhythmDraft>(defaultWorkRhythmDraft);
  const workRhythmRef = useRef(workRhythm);
  const savedWorkRhythmRef = useRef(workRhythm);
  const {
    breakRemindersEnabled,
    breakReminderIntervalMinutes,
    breakReminderCooldownMinutes,
    breakReminderQuietHoursEnabled,
    breakReminderQuietHoursStart,
    breakReminderQuietHoursEnd,
  } = workRhythm;
  const [htmlPreviewEnabled, setHtmlPreviewEnabled] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [preferencesStatus, setPreferencesStatus] = useState("");
  const [notificationPermission, setNotificationPermission] = useState("按需申请");
  const [screenCapturePermission, setScreenCapturePermission] = useState("截图时按需申请");
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateUrl, setUpdateUrl] = useState("");
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState("");
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("尚未测试连接");
  const [isTesting, setIsTesting] = useState(false);
  const [speechModels, setSpeechModels] = useState<SpeechModelStatus[]>([]);
  const [speechModelProgress, setSpeechModelProgress] = useState<Record<string, SpeechModelDownloadProgress>>({});
  const [downloadingSpeechModelId, setDownloadingSpeechModelId] = useState("");
  const [speechModelNotice, setSpeechModelNotice] = useState("");
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDueAt, setReminderDueAt] = useState(defaultReminderTime);
  const [reminderRepeat, setReminderRepeat] = useState<ReminderRepeat>("none");
  const [reminderError, setReminderError] = useState("");
  const [memos, setMemos] = useState<Memo[]>([]);
  const [memoSummaries, setMemoSummaries] = useState<MemoSummaryGroup[]>([]);
  const [memoTitle, setMemoTitle] = useState("");
  const [memoContent, setMemoContent] = useState("");
  const [memoCategoryFilter, setMemoCategoryFilter] = useState<MemoCategory | "all">("all");
  const [editingMemoId, setEditingMemoId] = useState("");
  const [memoError, setMemoError] = useState("");
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarTitle, setCalendarTitle] = useState("");
  const [calendarStartAt, setCalendarStartAt] = useState(defaultCalendarStartTime);
  const [calendarEndAt, setCalendarEndAt] = useState(defaultCalendarEndTime);
  const [calendarError, setCalendarError] = useState("");
  const [calendarNotice, setCalendarNotice] = useState("");
  const [calendarSyncStatus, setCalendarSyncStatus] = useState<CalendarSyncStatus>({
    platform: "unknown",
    available: false,
    lastSync: null,
    mappingCount: 0,
  });
  const [calendarSyncNotice, setCalendarSyncNotice] = useState("");
  /**
   * 瞬时状态 → Toast 桥接。
   * 这 5 个 state 只用于一次性反馈（已保存 / 失败 / 正在下载…），不再有内联渲染点。
   * 集中在这里弹提示再清空，调用点保持原样，避免 20 处分散改造。
   */
  useEffect(() => {
    const channels = [
      { value: updateStatus, tone: toneFromStatus(updateStatus), reset: () => setUpdateStatus("") },
      { value: preferencesStatus, tone: toneFromStatus(preferencesStatus), reset: () => setPreferencesStatus("") },
      { value: speechModelNotice, tone: toneFromStatus(speechModelNotice, "success"), reset: () => setSpeechModelNotice("") },
      { value: calendarNotice, tone: "info" as ToastTone, reset: () => setCalendarNotice("") },
      { value: calendarSyncNotice, tone: toneFromStatus(calendarSyncNotice), reset: () => setCalendarSyncNotice("") },
    ];
    const pending = channels.filter((channel) => channel.value);
    if (!pending.length) return;
    for (const channel of pending) {
      toast.show({ message: channel.value, tone: channel.tone });
      channel.reset();
    }
  }, [calendarNotice, calendarSyncNotice, preferencesStatus, speechModelNotice, toast, updateStatus]);
  const [externalPlugins, setExternalPlugins] = useState<InstalledPlugin[]>([]);
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [focusState, setFocusState] = useState<FocusSnapshot>(defaultFocusSnapshot);
  const [workRhythmState, setWorkRhythmState] = useState<WorkRhythmState>(defaultWorkRhythmState);
  const [interactionStats, setInteractionStats] = useState<InteractionStats>(loadInteractionStats());
  const [growthSnapshot, setGrowthSnapshot] = useState<GrowthSnapshot>(loadGrowthSnapshot());
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus>({
    required: false,
    completed: true,
    version: "",
  });
  const statuses = useMemo(
    () => [
      ["桌面精灵", "在线"],
      ["AI 对话", connectionStatus],
      ["文件处理", "可用"],
      ["提醒", "可用"],
    ],
    [connectionStatus],
  );
  const lastInteractionLabel = interactionStats.lastInteractionAt
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(interactionStats.lastInteractionAt)
    : "暂无";
  const filteredMemos = useMemo(
    () =>
      memoCategoryFilter === "all"
        ? memos
        : memos.filter((memo) => memo.category === memoCategoryFilter),
    [memoCategoryFilter, memos],
  );

  async function loadChatHistory() {
    const items = await runCommand<ChatHistoryEntry[]>("list_chat_history", undefined, []);
    setChatHistory(items);
  }

  async function loadReminders() {
    const items = await runCommand<Reminder[]>("list_reminders", undefined, []);
    setReminders(items);
  }

  async function loadMemos() {
    const items = await runCommand<Memo[]>("list_memos", undefined, []);
    setMemos(items);
  }

  async function loadMemoSummaries() {
    const items = await runCommand<MemoSummaryGroup[]>("summarize_memos", undefined, []);
    setMemoSummaries(items);
  }

  async function loadCalendarEvents() {
    const items = await runCommand<CalendarEvent[]>("list_calendar_events", undefined, []);
    setCalendarEvents(items);
  }

  async function loadCalendarSyncStatus() {
    const status = await runCommand<CalendarSyncStatus>("get_calendar_sync_status", undefined, {
      platform: "unknown",
      available: false,
      lastSync: null,
      mappingCount: 0,
    });
    setCalendarSyncStatus(status);
  }

  async function loadWorkRhythmState() {
    const state = await runCommand<WorkRhythmState>("get_work_rhythm_state", undefined, defaultWorkRhythmState);
    setWorkRhythmState(state);
  }

  async function createReminderAndRefresh(input: { title: string; dueAt: number; repeat: ReminderRepeat }) {
    if (!isTauriRuntime) {
      return runCommand<Reminder>(
        "create_reminder",
        { input },
        {
          id: crypto.randomUUID(),
          title: input.title.trim(),
          dueAt: input.dueAt,
          status: "pending",
          repeat: input.repeat,
        },
      );
    }

    return runCommandAndRefresh<Reminder>("create_reminder", { input }, [loadReminders]);
  }

  async function createCalendarEventAndRefresh(input: { title: string; startAt: number; endAt: number }) {
    if (!isTauriRuntime) {
      return runCommand<CalendarEvent>(
        "create_calendar_event",
        { input },
        { id: crypto.randomUUID(), title: input.title.trim(), startAt: input.startAt, endAt: input.endAt },
      );
    }

    return runCommandAndRefresh<CalendarEvent>("create_calendar_event", { input }, [loadCalendarEvents]);
  }

  async function loadSpeechModels() {
    const models = await runCommand<SpeechModelStatus[]>("get_speech_model_status", undefined, [
      {
        id: "base",
        name: "Whisper Base",
        fileName: "ggml-base.bin",
        downloadUrl: "",
        downloaded: false,
        byteSize: 0,
      },
    ]);
    setSpeechModels(models);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setQuietMode(settings.quietMode);
      setAiSettings(settings.ai);
      applyServerPreferences(settings);
      applyServerWorkRhythm(settings);
      setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
      setConnectionStatus(settings.hasApiKey ? "已配置密钥" : "等待测试");
    });
    void loadChatHistory();
    void loadReminders();
    void loadMemos();
    void loadMemoSummaries();
    void loadCalendarEvents();
    void loadCalendarSyncStatus();
    void loadWorkRhythmState();
    void loadSpeechModels();
    void runCommand<InstalledPlugin[]>("list_external_plugins", undefined, []).then(setExternalPlugins);
    void runCommand<FocusSnapshot>("get_focus_state", undefined, defaultFocusSnapshot).then(setFocusState);
    void runCommand<OnboardingStatus>("get_onboarding_status", undefined, {
      required: false,
      completed: true,
      version: "",
    }).then(setOnboardingStatus);
    void runCommand<string>("screen_capture_permission_status", undefined, "截图时按需申请").then(
      setScreenCapturePermission,
    );
    if (isTauriRuntime) {
      void isEnabled().then(setAutostartEnabled);
      void isPermissionGranted().then((granted) => {
        setNotificationPermission(granted ? "已授权" : "按需申请");
      });
    }

    if (!isTauriRuntime) return;
    const unlisten = listen("reminders-updated", () => {
      void loadReminders();
    });
    const unlistenMemos = listen("memos-updated", () => {
      void loadMemos();
      void loadMemoSummaries();
    });
    const unlistenHistory = listen("chat-history-updated", () => {
      void loadChatHistory();
    });
    const unlistenCalendar = listen("calendar-events-updated", () => {
      void loadCalendarEvents();
    });
    const unlistenCalendarSync = listen("calendar-sync-updated", () => {
      void loadCalendarSyncStatus();
    });
    const unlistenWorkRhythm = listen<WorkRhythmState>("work-rhythm-updated", (event) => {
      setWorkRhythmState(event.payload);
    });
    const unlistenTyping = listen("typing-stats-updated", () => {
      void loadWorkRhythmState();
    });
    const unlistenFocus = listen<FocusSnapshot>("focus-updated", (event) => {
      setFocusState(event.payload);
    });
    const unlistenSpeechModelProgress = listen<SpeechModelDownloadProgress>(
      "speech-model-download-progress",
      (event) => {
        setSpeechModelProgress((current) => ({
          ...current,
          [event.payload.modelId]: event.payload,
        }));
        if (event.payload.completed) {
          setDownloadingSpeechModelId("");
          void loadSpeechModels();
        }
      },
    );
    const unlistenSettings = listen<AppSettings>("settings-updated", (event) => {
      setQuietMode(event.payload.quietMode);
      setAiSettings(event.payload.ai);
      applyServerPreferences(event.payload);
      applyServerWorkRhythm(event.payload);
      setHtmlPreviewEnabled(event.payload.htmlPreviewEnabled);
    });
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        void runCommand<FocusSnapshot>("get_focus_state", undefined, defaultFocusSnapshot).then(setFocusState);
      }
    };
    document.addEventListener("visibilitychange", refreshOnVisible);
    const refreshInteraction = () => {
      setInteractionStats(loadInteractionStats());
      setGrowthSnapshot(loadGrowthSnapshot());
    };
    const unlistenInteraction = listen("piko-interaction-stats-changed", refreshInteraction);
    const unlistenGrowth = listen("piko-growth-state-changed", refreshInteraction);
    const refreshFromStorage = () => refreshInteraction();
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      void unlisten.then((dispose) => {
        dispose();
      });
      void unlistenHistory.then((dispose) => dispose());
      void unlistenMemos.then((dispose) => dispose());
      void unlistenCalendar.then((dispose) => dispose());
      void unlistenCalendarSync.then((dispose) => dispose());
      void unlistenWorkRhythm.then((dispose) => dispose());
      void unlistenTyping.then((dispose) => dispose());
      void unlistenFocus.then((dispose) => dispose());
      void unlistenSpeechModelProgress.then((dispose) => dispose());
      void unlistenSettings.then((dispose) => dispose());
      void unlistenInteraction.then((dispose) => dispose());
      void unlistenGrowth.then((dispose) => dispose());
      window.removeEventListener("storage", refreshFromStorage);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, []);


  async function refreshOnboardingStatus() {
    const status = await runCommand<OnboardingStatus>("get_onboarding_status", undefined, {
      required: false,
      completed: true,
      version: "",
    });
    setOnboardingStatus(status);
    return status;
  }

  /** 服务端返回的设置是唯一权威值（00 §5.8）；只有这里会推进「已保存基线」。 */
  function applyServerPreferences(settings: AppSettings) {
    const next = toPreferencesDraft(settings);
    savedPreferencesRef.current = next;
    preferencesRef.current = next;
    setPreferences(next);
  }

  function applyServerWorkRhythm(settings: AppSettings) {
    const next = toWorkRhythmDraft(settings);
    savedWorkRhythmRef.current = next;
    workRhythmRef.current = next;
    setWorkRhythm(next);
  }

  function updatePreferences(patch: Partial<PreferencesDraft>) {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    // update_preferences 是整组替换，必须带上组内全部字段，不能只传改动的那个。
    autoSave.schedule(
      () =>
        runCommand<AppSettings>("update_preferences", { input: next }, {
          ...defaultAppSettings,
          ...next,
          ai: aiSettings,
        }),
      {
        rollback: () => {
          const saved = savedPreferencesRef.current;
          preferencesRef.current = saved;
          setPreferences(saved);
        },
        onSuccess: applyServerPreferences,
        errorFallback: "个性化设置保存失败，请重试。",
      },
    );
  }

  function updateWorkRhythm(patch: Partial<WorkRhythmDraft>) {
    const next = { ...workRhythmRef.current, ...patch };
    workRhythmRef.current = next;
    setWorkRhythm(next);
    if (!isWorkRhythmDraftValid(next)) {
      autoSave.cancel();
      return;
    }
    autoSave.schedule(
      () =>
        runCommand<AppSettings>("update_work_rhythm_preferences", { input: next }, {
          ...defaultAppSettings,
          ...next,
          ai: aiSettings,
        }),
      {
        rollback: () => {
          const saved = savedWorkRhythmRef.current;
          workRhythmRef.current = saved;
          setWorkRhythm(saved);
        },
        onSuccess: applyServerWorkRhythm,
        errorFallback: "休息提醒设置保存失败，请重试。",
      },
    );
  }

  function updateQuietMode(mode: QuietMode) {
    setQuietMode(mode);
    void runCommand<AppSettings>("update_quiet_mode", { quietMode: mode }, {
      ...defaultAppSettings,
      quietMode: mode,
      ai: aiSettings,
    });
  }

  function updateAiField<Key extends keyof AiSettings>(key: Key, value: AiSettings[Key]) {
    setAiSettings((current) => ({ ...current, [key]: value }));
  }

  function updateProvider(provider: string) {
    const preset = providerOptions.find((option) => option.value === provider);
    setAiSettings((current) => ({
      ...current,
      provider,
      baseUrl: preset?.baseUrl ?? current.baseUrl,
      model: preset?.model ?? current.model,
    }));
  }

  async function saveAiSettings() {
    const settings = await runCommand<AppSettings>(
      "update_ai_settings",
      { input: { ...aiSettings, apiKey: apiKey || undefined } },
      { ...defaultAppSettings, ai: aiSettings },
    );
    setAiSettings(settings.ai);
    setApiKey("");
    return settings;
  }

  async function downloadSpeechModel(modelId: string) {
    setSpeechModelNotice("");
    setDownloadingSpeechModelId(modelId);
    try {
      const model = await runCommand<SpeechModelStatus>("download_speech_model", {
        input: { modelId },
      });
      setSpeechModels((current) => current.map((item) => (item.id === model.id ? model : item)));
      setSpeechModelNotice(`${model.name} 已可用`);
    } catch (error) {
      setSpeechModelNotice(toUserMessage(error));
    } finally {
      setDownloadingSpeechModelId("");
      void loadSpeechModels();
    }
  }

  async function testConnection() {
    setIsTesting(true);
    setConnectionStatus("正在连接...");
    try {
      await saveAiSettings();
      const models = await runCommand<ModelInfo[]>("list_models", undefined, [
        { id: aiSettings.model },
      ]);
      const modelNames = models.map((model) => model.id).join("、");
      setConnectionStatus(models.length ? `已连接：${modelNames}` : "已连接，未发现模型");
    } catch (error) {
      setConnectionStatus(`连接失败：${toUserMessage(error)}`);
    } finally {
      setIsTesting(false);
    }
  }

  async function clearChatHistory() {
    await runCommandAndRefresh("clear_chat_history", undefined, [loadChatHistory]);
  }

  async function createReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dueAt = Math.floor(new Date(reminderDueAt).getTime() / 1000);
    if (!reminderTitle.trim() || !Number.isFinite(dueAt)) return;

    setReminderError("");
    try {
      if (isTauriRuntime && !(await isPermissionGranted())) {
        const permission = await requestPermission();
        if (permission !== "granted") {
          setReminderError("未授予通知权限，提醒会保存，但系统可能无法弹出通知。");
        } else {
          setNotificationPermission("已授权");
        }
      }
      const reminder = await createReminderAndRefresh({ title: reminderTitle, dueAt, repeat: reminderRepeat });
      if (!isTauriRuntime) {
        setReminders((current) => [...current, reminder].sort((left, right) => left.dueAt - right.dueAt));
      }
      setReminderTitle("");
      setReminderDueAt(defaultReminderTime());
    } catch (error) {
      setReminderError(toUserMessage(error));
    }
  }

  async function deleteReminder(id: string) {
    try {
      await runCommandAndRefresh("delete_reminder", { id }, [loadReminders]);
    } catch (error) {
      setReminderError(toUserMessage(error));
    }
  }

  async function saveMemo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!memoTitle.trim() || !memoContent.trim()) return;

    setMemoError("");
    try {
      if (!isTauriRuntime) {
        const now = Math.floor(Date.now() / 1000);
        const memo: Memo = {
          id: editingMemoId || crypto.randomUUID(),
          title: memoTitle.trim(),
          content: memoContent.trim(),
          category: "other",
          summary: memoContent.trim().slice(0, 96),
          tags: ["其他"],
          createdAt: now,
          updatedAt: now,
        };
        setMemos((current) => {
          const next = editingMemoId
            ? current.map((item) => (item.id === memo.id ? memo : item))
            : [memo, ...current];
          return next.sort((left, right) => right.updatedAt - left.updatedAt);
        });
        setMemoTitle("");
        setMemoContent("");
        setEditingMemoId("");
        return;
      }
      const args = { input: { title: memoTitle, content: memoContent } };
      if (editingMemoId) {
        await runCommandAndRefresh<Memo>("update_memo", { id: editingMemoId, ...args }, [loadMemos, loadMemoSummaries]);
      } else {
        await runCommandAndRefresh<Memo>("create_memo", args, [loadMemos, loadMemoSummaries]);
      }
      setMemoTitle("");
      setMemoContent("");
      setEditingMemoId("");
    } catch (error) {
      setMemoError(toUserMessage(error));
    }
  }

  function editMemo(memo: Memo) {
    setEditingMemoId(memo.id);
    setMemoTitle(memo.title);
    setMemoContent(memo.content);
    setPanelTab("memos");
  }

  function cancelMemoEdit() {
    setEditingMemoId("");
    setMemoTitle("");
    setMemoContent("");
    setMemoError("");
  }

  async function deleteMemo(id: string) {
    try {
      if (!isTauriRuntime) {
        setMemos((current) => current.filter((memo) => memo.id !== id));
        return;
      }
      await runCommandAndRefresh("delete_memo", { id }, [loadMemos, loadMemoSummaries]);
    } catch (error) {
      setMemoError(toUserMessage(error));
    }
  }

  async function createCalendarEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startAt = Math.floor(new Date(calendarStartAt).getTime() / 1000);
    const endAt = Math.floor(new Date(calendarEndAt).getTime() / 1000);
    if (!calendarTitle.trim() || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return;

    const conflictCount = countCalendarConflicts(calendarEvents, startAt, endAt);
    const conflictNotice =
      conflictCount > 0 ? `提示：该时间段与已有 ${conflictCount} 条日程重叠，但已继续创建。` : "";
    setCalendarError("");
    setCalendarNotice("");
    try {
      const calendarEvent = await createCalendarEventAndRefresh({ title: calendarTitle, startAt, endAt });
      if (!isTauriRuntime) {
        setCalendarEvents((current) =>
          [...current, calendarEvent].sort((left, right) => left.startAt - right.startAt),
        );
      }
      setCalendarNotice(conflictNotice);
      setCalendarTitle("");
      setCalendarStartAt(defaultCalendarStartTime());
      setCalendarEndAt(defaultCalendarEndTime());
    } catch (error) {
      setCalendarError(toUserMessage(error));
    }
  }

  async function deleteCalendarEvent(id: string) {
    try {
      await runCommandAndRefresh("delete_calendar_event", { id }, [loadCalendarEvents]);
    } catch (error) {
      setCalendarError(toUserMessage(error));
    }
  }

  async function exportCalendar() {
    const path = await save({
      defaultPath: "piko-calendar.ics",
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (!path) return;
    setCalendarError("");
    try {
      await runCommand("export_calendar_events", { path });
      if (window.confirm("日程已导出。是否交给系统日历导入？")) {
        await runCommand("open_calendar_import", { path });
      }
    } catch (error) {
      setCalendarError(toUserMessage(error));
    }
  }

  async function chooseCustomPetImage() {
    if (!isTauriRuntime) return;
    const path = await open({
      multiple: false,
      filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (typeof path !== "string") return;
    setCustomPetImagePath(path);
    setPetVisualStyle("custom");
  }

  function clearCustomPetImage() {
    clearCustomPetImagePath();
    if (petVisualStyle === "custom") setPetVisualStyle("lumi");
  }

  async function syncCalendarToSystem() {
    setCalendarSyncNotice("");
    try {
      const result = await runCommand<{ pushed: number; mappingCount: number }>("sync_calendar_to_system");
      setCalendarSyncNotice(`已同步到系统日历：${result.pushed} 条`);
    } catch (error) {
      setCalendarSyncNotice(`同步到系统日历失败：${toUserMessage(error)}`);
    }
  }

  async function syncCalendarFromSystem() {
    setCalendarSyncNotice("");
    try {
      const result = await runCommand<{ imported: number; events: CalendarEvent[] }>("sync_calendar_from_system");
      setCalendarSyncNotice(`已从系统日历同步：${result.imported} 条`);
    } catch (error) {
      setCalendarSyncNotice(`从系统日历同步失败：${toUserMessage(error)}`);
    }
  }

  async function updateFocus(command: string, args?: Record<string, unknown>) {
    setFocusState(await runCommand<FocusSnapshot>(command, args, defaultFocusSnapshot));
  }

  async function updateHtmlPreviewEnabled(enabled: boolean) {
    try {
      const settings = await runCommand<AppSettings>(
        "update_html_preview_enabled",
        { enabled },
        { ...defaultAppSettings, htmlPreviewEnabled: enabled, ai: aiSettings },
      );
      setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
      setPreferencesStatus("HTML 预览插件已更新");
    } catch (error) {
      setPreferencesStatus(`HTML 预览插件更新失败：${toUserMessage(error)}`);
    }
  }

  async function toggleAutostart() {
    try {
      if (autostartEnabled) {
        await disable();
      } else {
        await enable();
      }
      setAutostartEnabled(!autostartEnabled);
    } catch (error) {
      setPreferencesStatus(`开机启动设置失败：${toUserMessage(error)}`);
    }
  }

  async function checkForUpdates() {
    setUpdateStatus("正在检查更新...");
    setUpdateUrl("");
    setDownloadedUpdatePath("");
    try {
      const update = await runCommand<UpdateStatus>("check_for_updates_extended", undefined, {
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        available: false,
        releaseUrl: "",
        releaseNotes: null,
        downloadUrl: null,
        assetName: null,
      });
      setUpdateStatus(update.available ? `发现新版本：${update.latestVersion}` : `已是最新版本：${update.currentVersion}`);
      setUpdateUrl(update.releaseUrl);
    } catch (error) {
      setUpdateStatus(`检查更新失败：${toUserMessage(error)}`);
    }
  }

  async function downloadUpdate() {
    if (!updateUrl) return;
    setIsDownloadingUpdate(true);
    setUpdateStatus("正在下载更新...");
    try {
      const update = await runCommand<UpdateStatus>("check_for_updates_extended", undefined, {
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        available: false,
        releaseUrl: updateUrl,
        releaseNotes: null,
        downloadUrl: null,
        assetName: null,
      });
      if (!update.downloadUrl) {
        setUpdateStatus("未找到可下载的安装包，请打开发布页手动下载。");
        return;
      }
      const downloaded = await runCommand<{ filePath: string; fileName: string; downloadedBytes: number }>(
        "download_update_asset",
        { downloadUrl: update.downloadUrl, assetName: update.assetName },
      );
      setDownloadedUpdatePath(downloaded.filePath);
      setUpdateStatus(`下载完成：${downloaded.fileName}`);
    } catch (error) {
      setUpdateStatus(`更新下载失败：${toUserMessage(error)}`);
    } finally {
      setIsDownloadingUpdate(false);
    }
  }

  if (onboardingStatus.required) {
    return (
      <OnboardingWindow
        onComplete={() => {
          void refreshOnboardingStatus();
        }}
        onSkip={() => {
          void refreshOnboardingStatus();
        }}
      />
    );
  }

  return (
    <main className={`panel-shell panel-shell--${theme}`}>
      <PanelHeader tab={panelTab} companionName={companionName} />
      <PanelNavigation tab={panelTab} onChange={setPanelTab} />
      <div className="panel-workspace" ref={workspaceRef}>
      <section className={`panel-overview panel-overview--${panelTab}`} aria-label="面板总览">
        <div className="panel-overview__status">
          <span>AI 对话</span>
          <strong>{connectionStatus}</strong>
        </div>
        <div>
          <span>今日专注</span>
          <strong>{focusState.todayMinutes} 分钟</strong>
        </div>
        <div>
          <span>亲密度</span>
          <strong>{Math.round(interactionStats.intimacy)}</strong>
        </div>
        <div>
          <span>最近互动</span>
          <strong>{lastInteractionLabel}</strong>
        </div>
      </section>

      {panelTab === "companion" && <CompanionHero companionName={companionName} styleLabel={petVisualStyleLabel} onReminders={() => setPanelTab("reminders")} />}

      {panelTab === "companion" && (
        <>
      <details className="panel-card companion-metrics-card panel-section panel-section--companion"><summary>一起成长的记录 <span>Lv. {growthSnapshot.level} · {Math.round(interactionStats.intimacy)} 亲密</span></summary><div className="companion-metrics-detail">
        <div className="section-heading">
          <div>
            <p className="eyebrow">INTERACTION</p>
            <h2>互动档案</h2>
          </div>
          <strong>{Math.round(interactionStats.intimacy)} 亲密</strong>
        </div>
        <div className="status-grid">
          <div className="status-item">
            <span>互动总数</span>
            <strong>{interactionStats.totalInteractions.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>摸摸次数</span>
            <strong>{interactionStats.petStrokeCount.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>文件协作</span>
            <strong>{interactionStats.dropCount.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>当前等级</span>
            <strong>{growthSnapshot.level}</strong>
          </div>
        </div>
        <div className="permission-list" style={{ marginTop: "6px" }}>
          <div>
            <span>经验进度</span>
            <strong>{Math.round(growthSnapshot.percentage)}%</strong>
          </div>
          <div>
            <span>羁绊等级</span>
            <strong>{growthSnapshot.attributeLevels.bond}</strong>
          </div>
          <div>
            <span>社交等级</span>
            <strong>{growthSnapshot.attributeLevels.social}</strong>
          </div>
          <div>
            <span>最近互动</span>
            <strong>{lastInteractionLabel}</strong>
          </div>
        </div>
        <p className="empty-state">
          累计 {growthSnapshot.totalXp.toLocaleString("zh-CN")} 经验 · {growthSnapshot.completedTasks} 个任务进度 · {growthSnapshot.unlockedAchievements} 项成就
        </p>
      </div></details>
        </>
      )}

      {panelTab === "about" && (
        <>
      <section className="panel-card panel-section panel-section--about">
        <p className="eyebrow">PRIVACY & PERMISSIONS</p>
        <h2>权限中心</h2>
        <div className="permission-list">
          <div><span>通知权限</span><strong>{notificationPermission}</strong></div>
          <div><span>文件访问</span><strong>仅主动拖入</strong></div>
          <div><span>屏幕录制</span><strong>{screenCapturePermission}</strong></div>
          <div><span>主动感知</span><strong>{sensingPaused ? "已暂停" : "运行中"}</strong></div>
        </div>
      </section>

      <section className="panel-card panel-section panel-section--about">
        <p className="eyebrow">BUSINESS PLUGINS</p>
        <h2>外部插件</h2>
        {externalPlugins.length ? (
          <ul className="history-list">
            {externalPlugins.map((plugin) => (
              <li key={plugin.manifest.id}>
                <strong>{plugin.manifest.name}</strong>
                <span>{plugin.manifest.id} · {plugin.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">未发现外部插件清单。</p>
        )}
      </section>

      <section className="panel-card panel-section panel-section--about">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ABOUT</p>
            <h2>版本信息</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" onClick={() => void checkForUpdates()}>
              检查更新
            </button>
            <button type="button" disabled={!updateUrl || isDownloadingUpdate} onClick={() => void downloadUpdate()}>
              {isDownloadingUpdate ? "正在下载..." : "下载更新"}
            </button>
          </div>
        </div>
        <p className="empty-state">Piko Desktop Companion · v{appVersion}</p>
        {updateUrl && (
          <button className="release-link" type="button" onClick={() => void openUrl(updateUrl)}>
            打开下载页
          </button>
        )}
        {downloadedUpdatePath && (
          <button className="release-link" type="button" onClick={() => void openPath(downloadedUpdatePath)}>
            打开已下载文件
          </button>
        )}
      </section>
        </>
      )}

      {panelTab === "companion" && (
        <>
      <section className="panel-card companion-status-card panel-section panel-section--companion">
        <div className="section-heading">
          <div>
            <p className="eyebrow">STATUS</p>
            <h2>当前状态</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" onClick={() => runCommand("show_pet")}>显示精灵</button>
            <button type="button" onClick={() => runCommand("hide_pet")}>隐藏精灵</button>
          </div>
        </div>
        <div className="status-grid">
          {statuses.map(([label, value]) => (
            <div className="status-item" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <div className="section-heading" style={{ marginTop: "1.2rem" }}>
          <div>
            <p className="eyebrow">WORK RHYTHM</p>
            <h2>今日活跃度</h2>
          </div>
          <strong>{workRhythmState.isIdle ? "建议休息" : "继续工作"}</strong>
        </div>
        <div className="status-grid">
          <div className="status-item">
            <span>今日输入</span>
            <strong>{workRhythmState.typingCharactersToday.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>输入时长</span>
            <strong>{formatDuration(workRhythmState.typingSecondsToday)}</strong>
          </div>
          <div className="status-item">
            <span>前台应用</span>
            <strong>{workRhythmState.activeAppCategory}</strong>
          </div>
          <div className="status-item">
            <span>空闲时长</span>
            <strong>{formatDuration(workRhythmState.idleSeconds)}</strong>
          </div>
        </div>
      </section>
        </>
      )}

      {panelTab === "settings" && (
        <>
      <section className="panel-card panel-section panel-section--settings">
        <p className="eyebrow">PREFERENCES</p>
        <h2>个性化与系统</h2>
        <div className="settings-form">
          <label>
            <span>精灵名称</span>
            <input
              value={companionName}
              maxLength={24}
              onChange={(event) => updatePreferences({ companionName: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>主题色</span>
            <select value={theme} onChange={(event) => updatePreferences({ theme: event.currentTarget.value as Theme })}>
              <option value="sage">鼠尾草绿</option>
              <option value="blue">湖水蓝</option>
              <option value="peach">暖桃色</option>
            </select>
          </label>
          <label>
            <span>精灵形象</span>
            <select
              value={petVisualStyle}
              onChange={(event) => setPetVisualStyle(event.currentTarget.value as typeof petVisualStyle)}
            >
              {availablePetVisualStyleOptions.map(({ label, value }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="custom-pet-picker">
            <span>{customPetImagePath ? customPetImagePath.split(/[\\/]/).pop() : "未选择自定义图片"}</span>
            <div>
              <button type="button" onClick={() => void chooseCustomPetImage()}>
                选择图片
              </button>
              <button type="button" className="is-secondary" onClick={clearCustomPetImage} disabled={!customPetImagePath}>
                清除
              </button>
            </div>
          </div>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={!sensingPaused}
              onChange={(event) => updatePreferences({ sensingPaused: !event.currentTarget.checked })}
            />
            <span>主动感知</span>
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={autostartEnabled}
              onChange={() => void toggleAutostart()}
            />
            <span>开机自动启动</span>
          </label>
          <button
            type="button"
            onClick={() => {
              void runCommand<AppSettings>("reset_onboarding", undefined, {
                ...defaultAppSettings,
                companionName,
              }).then(() => refreshOnboardingStatus());
            }}
          >
            重新运行引导
          </button>
        </div>
      </section>

      <section className="panel-card panel-section panel-section--settings">
        <p className="eyebrow">PERSONALITY</p>
        <h2>互动活泼度</h2>
        <div className="segmented-control" aria-label="互动活泼度">
          {quietModeOptions.map(({ label, value }) => (
            <button
              className={value === quietMode ? "is-active" : ""}
              key={value}
              type="button"
              onClick={() => updateQuietMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel-card panel-section panel-section--settings">
        <p className="eyebrow">WORK RHYTHM</p>
        <h2>休息提醒</h2>
        <div className="settings-form">
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={breakRemindersEnabled}
              onChange={(event) => updateWorkRhythm({ breakRemindersEnabled: event.currentTarget.checked })}
            />
            <span>开启休息提醒</span>
          </label>
          <div className="settings-form__row">
            <label>
              <span>提醒间隔（分钟）</span>
              <input
                type="number"
                min="15"
                max="240"
                step="5"
                value={breakReminderIntervalMinutes}
                onChange={(event) => updateWorkRhythm({ breakReminderIntervalMinutes: Number(event.currentTarget.value) })}
              />
            </label>
            <label>
              <span>提醒冷却（分钟）</span>
              <input
                type="number"
                min="5"
                max="240"
                step="5"
                value={breakReminderCooldownMinutes}
                onChange={(event) => updateWorkRhythm({ breakReminderCooldownMinutes: Number(event.currentTarget.value) })}
              />
            </label>
          </div>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={breakReminderQuietHoursEnabled}
              onChange={(event) => updateWorkRhythm({ breakReminderQuietHoursEnabled: event.currentTarget.checked })}
            />
            <span>启用静默时段</span>
          </label>
          <div className="settings-form__row">
            <label>
              <span>静默开始</span>
              <input
                type="time"
                value={breakReminderQuietHoursStart}
                onChange={(event) => updateWorkRhythm({ breakReminderQuietHoursStart: event.currentTarget.value })}
              />
            </label>
            <label>
              <span>静默结束</span>
              <input
                type="time"
                value={breakReminderQuietHoursEnd}
                onChange={(event) => updateWorkRhythm({ breakReminderQuietHoursEnd: event.currentTarget.value })}
              />
            </label>
          </div>
          <p className="empty-state">提醒会根据今日输入、空闲状态和前台场景自动判断，只在适合的时候发声。</p>
        </div>
      </section>

      <section className="panel-card panel-section panel-section--settings">
        <p className="eyebrow">MODEL PROVIDER</p>
        <h2>模型服务</h2>
        <div className="settings-form">
          <label>
            <span>服务类型</span>
            <select
              value={aiSettings.provider}
              onChange={(event) => updateProvider(event.currentTarget.value)}
            >
              {providerOptions.map(({ label, value }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={aiSettings.baseUrl}
              onChange={(event) => updateAiField("baseUrl", event.currentTarget.value)}
              placeholder="http://localhost:11434/v1"
            />
          </label>
          <label>
            <span>Model</span>
            <input
              value={aiSettings.model}
              onChange={(event) => updateAiField("model", event.currentTarget.value)}
              placeholder={aiSettings.provider === "lmstudio" ? "可留空，LM Studio 自动使用当前加载模型" : "gemma4:e4b"}
            />
          </label>
          {speechModels.length > 0 && (
            <div className="speech-model-list">
              {speechModels.map((model) => {
                const progress = speechModelProgress[model.id];
                const percent = progress?.percent === undefined ? undefined : Math.round(progress.percent * 100);
                const isDownloading = downloadingSpeechModelId === model.id;
                return (
                  <div className="speech-model-item" key={model.id}>
                    <div>
                      <strong>
                        {model.name}
                        {model.id === "sense-voice" ? (
                          <span className="speech-model-item__badge">中文优化</span>
                        ) : null}
                      </strong>
                      <span>
                        {model.downloaded ? `${formatBytes(model.byteSize)} · 已下载` : "未下载"}
                        {isDownloading && percent !== undefined ? ` · ${percent}%` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={model.downloaded || Boolean(downloadingSpeechModelId)}
                      onClick={() => void downloadSpeechModel(model.id)}
                    >
                      {model.downloaded ? "已下载" : isDownloading ? "下载中..." : "下载"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {speechModels.some((m) => m.id === "sense-voice" && !m.downloaded) && (
            <p className="empty-state">
              「SenseVoice 中文优化」—— 阿里 FunAudioLLM 出品，专为中文设计，字错率比 Whisper 低一半以上，且几乎不出繁体字。
            </p>
          )}
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="本地 Ollama 可留空"
            />
          </label>
          <div className="settings-form__row">
            <label>
              <span>Temperature</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={aiSettings.temperature}
                onChange={(event) => updateAiField("temperature", Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span>超时秒数</span>
              <input
                type="number"
                min="5"
                max="600"
                value={aiSettings.timeoutSeconds}
                onChange={(event) =>
                  updateAiField("timeoutSeconds", Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
          <button type="button" disabled={isTesting} onClick={testConnection}>
            {isTesting ? "正在测试..." : "保存并测试连接"}
          </button>
          <p
            className={`feedback-status${connectionStatus.startsWith("连接失败") ? " feedback-status--error" : ""}`}
          >
            {connectionStatus}
          </p>
        </div>
      </section>

      <section className="panel-card panel-section panel-section--settings">
        <p className="eyebrow">OUTPUT PREVIEW</p>
        <h2>HTML 预览</h2>
        <div className="feature-toggle-card">
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={htmlPreviewEnabled}
              onChange={(event) => void updateHtmlPreviewEnabled(event.currentTarget.checked)}
            />
            <span>HTML 预览插件</span>
          </label>
          <p className="empty-state">开启后，气泡窗口会在检测到 HTML 片段时优先使用沙箱 iframe 预览。</p>
        </div>
      </section>
        </>
      )}

      {panelTab === "reminders" && (
        <>
      <section className="panel-card panel-section panel-section--reminders">
        <div className="focus-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">FOCUS TIMER</p>
              <h2>{focusState.kind === "break" ? "休息倒计时" : "专注模式"}</h2>
            </div>
            <strong>{formatFocusRemaining(focusState.remainingSeconds)}</strong>
          </div>
          {focusState.status === "idle" ? (
            <div className="focus-controls">
              <select value={focusMinutes} onChange={(event) => setFocusMinutes(Number(event.currentTarget.value))} aria-label="专注时长">
                {[15, 25, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
              </select>
              <button type="button" onClick={() => void updateFocus("start_focus", { minutes: focusMinutes })}>开始专注</button>
              {[5, 10, 15].map((minutes) => (
                <button key={minutes} type="button" onClick={() => void updateFocus("start_break", { minutes })}>
                  休息 {minutes}
                </button>
              ))}
            </div>
          ) : (
            <div className="focus-controls">
              <button type="button" onClick={() => void updateFocus(focusState.status === "paused" ? "resume_focus" : "pause_focus")}>
                {focusState.status === "paused" ? "继续" : "暂停"}
              </button>
              <button type="button" onClick={() => void updateFocus("stop_focus")}>结束</button>
            </div>
          )}
        </div>
        <p className="eyebrow">REMINDERS</p>
        <h2>提醒事项</h2>
        <form className="reminder-form" onSubmit={createReminder}>
          <input
            value={reminderTitle}
            onChange={(event) => setReminderTitle(event.currentTarget.value)}
            maxLength={120}
            placeholder="例如：起来活动一下"
            aria-label="提醒内容"
          />
          <div>
            <input
              type="datetime-local"
              value={reminderDueAt}
              onChange={(event) => setReminderDueAt(event.currentTarget.value)}
              aria-label="提醒时间"
            />
            <button type="submit" disabled={!reminderTitle.trim() || !reminderDueAt}>
              添加
            </button>
          </div>
          <select
            value={reminderRepeat}
            onChange={(event) => setReminderRepeat(event.currentTarget.value as ReminderRepeat)}
            aria-label="重复规则"
          >
            {reminderRepeatOptions.map(({ label, value }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </form>
        {reminderError && <ErrorState message={reminderError} onDismiss={() => setReminderError("")} />}
        {reminders.length ? (
          <ul className="reminder-list">
            {reminders.map((reminder) => (
              <li key={reminder.id}>
                <div>
                  <strong>{reminder.title}</strong>
                  <span>
                    {formatReminderTime(reminder.dueAt)} ·{" "}
                    {reminder.status === "triggered" ? "已提醒" : "等待中"} ·{" "}
                    {reminderRepeatLabel(reminder.repeat)}
                  </span>
                </div>
                <button type="button" onClick={() => void deleteReminder(reminder.id)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">暂无提醒。</p>
        )}
      </section>
        </>
      )}

      {panelTab === "calendar" && (
        <>
      <section className="panel-card panel-section panel-section--calendar">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CALENDAR</p>
            <h2>本地日程</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" disabled={!calendarEvents.length} onClick={() => void exportCalendar()}>
              导出 iCalendar
            </button>
            <button type="button" disabled={!calendarSyncStatus.available} onClick={() => void syncCalendarToSystem()}>
              同步到系统日历
            </button>
            <button type="button" disabled={!calendarSyncStatus.available} onClick={() => void syncCalendarFromSystem()}>
              从系统日历同步
            </button>
          </div>
        </div>
        <p className="empty-state">
          {calendarSyncStatus.available
            ? `系统同步已就绪 · ${calendarSyncStatus.platform} · 映射 ${calendarSyncStatus.mappingCount} 条`
            : "当前平台未开放系统日历直连，同步按钮将保持为导出/导入式兼容路径。"}
        </p>
        <form className="reminder-form" onSubmit={createCalendarEvent}>
          <input
            value={calendarTitle}
            onChange={(event) => setCalendarTitle(event.currentTarget.value)}
            maxLength={120}
            placeholder="例如：项目评审"
            aria-label="日程标题"
          />
          <input
            type="datetime-local"
            value={calendarStartAt}
            onChange={(event) => setCalendarStartAt(event.currentTarget.value)}
            aria-label="日程开始时间"
          />
          <div>
            <input
              type="datetime-local"
              value={calendarEndAt}
              onChange={(event) => setCalendarEndAt(event.currentTarget.value)}
              aria-label="日程结束时间"
            />
            <button type="submit" disabled={!calendarTitle.trim() || !calendarStartAt || !calendarEndAt}>
              添加
            </button>
          </div>
        </form>
        {calendarError && <ErrorState message={calendarError} onDismiss={() => setCalendarError("")} />}
        {calendarEvents.length ? (
          <ul className="reminder-list">
            {calendarEvents.map((event) => (
              <li key={event.id}>
                <div>
                  <strong>{event.title}</strong>
                  <span>{formatCalendarRange(event.startAt, event.endAt)}</span>
                </div>
                <button type="button" onClick={() => void deleteCalendarEvent(event.id)}>删除</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">暂无日程。</p>
        )}
      </section>
        </>
      )}

      {panelTab === "memos" && (
        <>
      <section className="panel-card panel-section panel-section--memos">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MEMOS</p>
            <h2>备忘录</h2>
          </div>
          <select
            className="memo-filter-select"
            value={memoCategoryFilter}
            onChange={(event) => setMemoCategoryFilter(event.currentTarget.value as MemoCategory | "all")}
            aria-label="备忘录分类筛选"
          >
            {memoCategoryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <form className="memo-form" onSubmit={saveMemo}>
          <input
            value={memoTitle}
            onChange={(event) => setMemoTitle(event.currentTarget.value)}
            maxLength={120}
            placeholder="标题，例如：下周版本复盘"
            aria-label="备忘录标题"
          />
          <textarea
            value={memoContent}
            onChange={(event) => setMemoContent(event.currentTarget.value)}
            maxLength={8000}
            rows={5}
            placeholder="写下内容，Piko 会自动分类、提炼摘要和标签"
            aria-label="备忘录内容"
          />
          <div className="memo-form__actions">
            {editingMemoId && (
              <button type="button" className="is-secondary" onClick={cancelMemoEdit}>
                取消编辑
              </button>
            )}
            <button type="submit" disabled={!memoTitle.trim() || !memoContent.trim()}>
              {editingMemoId ? "保存" : "添加"}
            </button>
          </div>
        </form>
        {memoError && <ErrorState message={memoError} onDismiss={() => setMemoError("")} />}
        {memoSummaries.length ? (
          <div className="memo-summary-grid">
            {memoSummaries.map((group) => (
              <button
                type="button"
                key={group.category}
                className={memoCategoryFilter === group.category ? "is-active" : ""}
                onClick={() => setMemoCategoryFilter(group.category)}
              >
                <span>{memoCategoryLabels[group.category]}</span>
                <strong>{group.count}</strong>
                <small>{group.summary}</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-state">新增备忘后会在这里自动汇总分类。</p>
        )}
        {filteredMemos.length ? (
          <div className="memo-list">
            {filteredMemos.map((memo) => (
              <article key={memo.id} className="memo-card">
                <header>
                  <span>{memoCategoryLabels[memo.category]}</span>
                  <time>{formatChatHistoryTime(memo.updatedAt)}</time>
                </header>
                <h3>{memo.title}</h3>
                <p>{memo.summary}</p>
                {memo.tags.length ? (
                  <div className="memo-tags">
                    {memo.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                ) : null}
                <footer>
                  <button type="button" onClick={() => editMemo(memo)}>
                    编辑
                  </button>
                  <button type="button" className="is-danger" onClick={() => void deleteMemo(memo.id)}>
                    删除
                  </button>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">
            {memos.length ? "当前分类下没有备忘录。" : "暂无备忘录。"}
          </p>
        )}
      </section>
        </>
      )}

      {panelTab === "history" && <PanelHistory chatHistory={chatHistory} focusMinutes={focusState.todayMinutes} onClear={clearChatHistory} />}


      {panelTab === "memory" && (
        <>
      <section className="panel-card panel-section panel-section--memory">
        <MemoryCenter />
      </section>
        </>
      )}
      </div>

    </main>
  );
}
