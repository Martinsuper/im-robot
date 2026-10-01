import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { OnboardingWindow } from "../onboarding/OnboardingWindow";
import { MemoryCenter } from "../memory/MemoryCenter";
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
  OnboardingStatus,
  PanelTab,
  QuietMode,
  Reminder,
  ReminderRepeat,
  UpdateStatus,
  WorkRhythmState,
} from "../../types/appTypes";
import {
  PetSprite,
  clearCustomPetImagePath,
  countCalendarConflicts,
  defaultAppSettings,
  defaultCalendarEndTime,
  defaultCalendarStartTime,
  defaultFocusSnapshot,
  defaultReminderTime,
  defaultWorkRhythmState,
  formatDuration,
  live2dModelOptions,
  panelTabOptions,
  petVisualStyleOptions,
  providerOptions,
  setCustomPetImagePath,
  setPetVisualStyle,
  useCustomPetImagePath,
  useLive2DModelId,
  usePetVisualStyle,
} from "../app/appShared";
import { isTauriRuntime, runCommand, runCommandAndRefresh, runCommandQuiet, reportCommandError } from "../app/appRuntime";
import { useTranslation } from "../i18n/I18nProvider";
import { useAppSettings } from "./useAppSettings";
import { HistorySection } from "./sections/HistorySection";
import { RemindersSection } from "./sections/RemindersSection";
import { CalendarSection } from "./sections/CalendarSection";
import {
  BreakReminderSection,
  HtmlPreviewSection,
  ModelProviderSection,
  PreferencesSection,
  QuietModeSection,
} from "./sections/SettingsSection";
import { chatHistoryMatchesSearch, getChatHistoryTags, type ChatHistoryFilter } from "./sections/chatHistoryFilters";

export function PanelWindow() {
  const { t } = useTranslation();
  const [panelTab, setPanelTab] = useState<PanelTab>("companion");
  const [connectionStatus, setConnectionStatus] = useState(() => t("panel.settings.notTested", "尚未测试连接"));
  const [appSettings, setAppSettings] = useAppSettings(
    useCallback((loaded: AppSettings) => {
      setConnectionStatus(loaded.hasApiKey ? t("panel.settings.keyConfigured", "已配置密钥") : t("panel.settings.waitingTest", "等待测试"));
    }, [t]),
  );
  const {
    companionName,
    theme,
    sensingPaused,
    breakRemindersEnabled,
    breakReminderIntervalMinutes,
    breakReminderCooldownMinutes,
    breakReminderQuietHoursEnabled,
    breakReminderQuietHoursStart,
    breakReminderQuietHoursEnd,
  } = appSettings;
  const aiSettings = appSettings.ai;
  const petVisualStyle = usePetVisualStyle();
  const live2dModelId = useLive2DModelId();
  const customPetImagePath = useCustomPetImagePath();
  const petVisualStyleOption = petVisualStyleOptions.find((option) => option.value === petVisualStyle);
  const petVisualStyleLabel = petVisualStyleOption
    ? t(petVisualStyleOption.labelKey, petVisualStyleOption.label)
    : t("app.petStyle.lumi", "机甲猫");
  const enabledLive2DModelOptions = live2dModelOptions.filter((option) => option.enabled);
  const live2dModelLabel =
    live2dModelOptions.find((option) => option.value === live2dModelId)?.label ?? enabledLive2DModelOptions[0]?.label;
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [preferencesStatus, setPreferencesStatus] = useState("");
  const [notificationPermission, setNotificationPermission] = useState(() => t("panel.settings.onDemand", "按需申请"));
  const [screenCapturePermission, setScreenCapturePermission] = useState(() => t("panel.settings.captureOnDemand", "截图时按需申请"));
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateUrl, setUpdateUrl] = useState("");
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState("");
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyFilter, setHistoryFilter] = useState<ChatHistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDueAt, setReminderDueAt] = useState(defaultReminderTime);
  const [reminderRepeat, setReminderRepeat] = useState<ReminderRepeat>("none");
  const [reminderError, setReminderError] = useState("");
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
      [t("panel.status.pet", "桌面精灵"), t("panel.status.online", "在线")],
      [t("panel.status.aiChat", "AI 对话"), connectionStatus],
      [t("panel.status.file", "文件处理"), t("panel.status.available", "可用")],
      [t("panel.status.reminders", "提醒"), t("panel.status.available", "可用")],
    ],
    [connectionStatus, t],
  );
  const panelSectionClass = (tab: PanelTab, base = "panel-card") =>
    `${base}${panelTab === tab ? "" : " is-hidden"}`;
  const filteredChatHistory = useMemo(
    () => {
      return chatHistory.filter((entry) => {
        const matchesFilter = historyFilter === "all" || getChatHistoryTags(entry).includes(historyFilter);
        return matchesFilter && chatHistoryMatchesSearch(entry, historySearch);
      });
    },
    [chatHistory, historyFilter, historySearch],
  );
  const selectedHistoryEntry = useMemo(() => {
    if (!filteredChatHistory.length) return undefined;
    return filteredChatHistory.find((entry) => entry.id === selectedHistoryId) ?? filteredChatHistory[0];
  }, [filteredChatHistory, selectedHistoryId]);

  async function loadChatHistory() {
    const items = await runCommand<ChatHistoryEntry[]>("list_chat_history", undefined, []);
    setChatHistory(items);
  }

  async function loadReminders() {
    const items = await runCommand<Reminder[]>("list_reminders", undefined, []);
    setReminders(items);
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

  useEffect(() => {
    // 设置的加载与订阅由 useAppSettings 负责
    // loader 含 setState，放进微任务等价于挂载后的异步加载，
    // 避免 effect 内同步调用造成级联渲染。
    queueMicrotask(() => {
      void loadChatHistory();
      void loadReminders();
      void loadCalendarEvents();
      void loadCalendarSyncStatus();
      void loadWorkRhythmState();
    });
    void runCommand<InstalledPlugin[]>("list_external_plugins", undefined, []).then(setExternalPlugins).catch(reportCommandError("list_external_plugins"));
    void runCommand<FocusSnapshot>("get_focus_state", undefined, defaultFocusSnapshot).then(setFocusState).catch(reportCommandError("get_focus_state"));
    void runCommand<OnboardingStatus>("get_onboarding_status", undefined, {
      required: false,
      completed: true,
      version: "",
    }).then(setOnboardingStatus).catch(reportCommandError("get_onboarding_status"));
    void runCommand<string>("screen_capture_permission_status", undefined, t("panel.settings.captureOnDemand", "截图时按需申请")).then(
      setScreenCapturePermission,
    ).catch(reportCommandError("screen_capture_permission_status"));
    if (isTauriRuntime) {
      void isEnabled().then(setAutostartEnabled).catch(reportCommandError("autostart isEnabled"));
      void isPermissionGranted().then((granted) => {
        setNotificationPermission(granted ? t("panel.settings.granted", "已授权") : t("panel.settings.onDemand", "按需申请"));
      }).catch(reportCommandError("notification isPermissionGranted"));
    }

    if (!isTauriRuntime) return;
    const unlisten = listen("reminders-updated", () => {
      void loadReminders();
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
    // settings-updated 订阅由 useAppSettings 负责
    // focus-updated 事件已推送状态，无需每秒轮询
    const refreshInteraction = () => {
      setInteractionStats(loadInteractionStats());
      setGrowthSnapshot(loadGrowthSnapshot());
    };
    const unlistenInteraction = listen("piko-interaction-stats-changed", refreshInteraction);
    const unlistenGrowth = listen("piko-growth-state-changed", refreshInteraction);
    const refreshFromStorage = () => refreshInteraction();
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenHistory.then((dispose) => dispose());
      void unlistenCalendar.then((dispose) => dispose());
      void unlistenCalendarSync.then((dispose) => dispose());
      void unlistenWorkRhythm.then((dispose) => dispose());
      void unlistenTyping.then((dispose) => dispose());
      void unlistenFocus.then((dispose) => dispose());
      void unlistenInteraction.then((dispose) => dispose());
      void unlistenGrowth.then((dispose) => dispose());
      window.removeEventListener("storage", refreshFromStorage);
    };
    // t 变化（切换语言）时重挂以刷新权限状态等初始文案
  }, [t]);

  // 选中项失效时在渲染期收敛到合法值（React 官方的 render 调整模式），
  // 避免在 effect 内同步 setState。
  if (
    filteredChatHistory.length === 0
      ? selectedHistoryId !== ""
      : !filteredChatHistory.some((entry) => entry.id === selectedHistoryId)
  ) {
    setSelectedHistoryId(filteredChatHistory.length ? filteredChatHistory[0].id : "");
  }

  async function refreshOnboardingStatus() {
    const status = await runCommand<OnboardingStatus>("get_onboarding_status", undefined, {
      required: false,
      completed: true,
      version: "",
    });
    setOnboardingStatus(status);
    return status;
  }

  function updateQuietMode(mode: QuietMode) {
    setAppSettings((current) => ({ ...current, quietMode: mode }));
    runCommandQuiet("update_quiet_mode", { quietMode: mode });
  }

  function updateAiField<Key extends keyof AiSettings>(key: Key, value: AiSettings[Key]) {
    setAppSettings((current) => ({ ...current, ai: { ...current.ai, [key]: value } }));
  }

  function updateProvider(provider: string) {
    const preset = providerOptions.find((option) => option.value === provider);
    setAppSettings((current) => ({
      ...current,
      ai: {
        ...current.ai,
        provider,
        baseUrl: preset?.baseUrl ?? current.ai.baseUrl,
        model: preset?.model ?? current.ai.model,
      },
    }));
  }

  async function saveAiSettings() {
    const settings = await runCommand<AppSettings>(
      "update_ai_settings",
      { input: { ...aiSettings, apiKey: apiKey || undefined } },
      { ...defaultAppSettings, ai: aiSettings },
    );
    setAppSettings((current) => ({ ...current, ai: settings.ai }));
    setApiKey("");
    return settings;
  }

  async function testConnection() {
    setIsTesting(true);
    setConnectionStatus(t("panel.settings.connecting", "正在连接..."));
    try {
      await saveAiSettings();
      await runCommand<string>("test_connection");
      setConnectionStatus(t("panel.settings.connectSuccess", "连接成功"));
    } catch (error) {
      setConnectionStatus(t("panel.settings.connectFailed", "连接失败：{error}").replace("{error}", String(error)));
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
          setReminderError(t("panel.reminders.permissionNotice", "未授予通知权限，提醒会保存，但系统可能无法弹出通知。"));
        } else {
          setNotificationPermission(t("panel.settings.granted", "已授权"));
        }
      }
      const reminder = await createReminderAndRefresh({ title: reminderTitle, dueAt, repeat: reminderRepeat });
      if (!isTauriRuntime) {
        setReminders((current) => [...current, reminder].sort((left, right) => left.dueAt - right.dueAt));
      }
      setReminderTitle("");
      setReminderDueAt(defaultReminderTime());
    } catch (error) {
      setReminderError(String(error));
    }
  }

  async function deleteReminder(id: string) {
    try {
      await runCommandAndRefresh("delete_reminder", { id }, [loadReminders]);
    } catch (error) {
      setReminderError(String(error));
    }
  }

  async function createCalendarEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startAt = Math.floor(new Date(calendarStartAt).getTime() / 1000);
    const endAt = Math.floor(new Date(calendarEndAt).getTime() / 1000);
    if (!calendarTitle.trim() || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return;

    const conflictCount = countCalendarConflicts(calendarEvents, startAt, endAt);
    const conflictNotice =
      conflictCount > 0
        ? t("panel.calendar.conflictNotice", "提示：该时间段与已有 {count} 条日程重叠，但已继续创建。").replace("{count}", String(conflictCount))
        : "";
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
      setCalendarError(String(error));
    }
  }

  async function deleteCalendarEvent(id: string) {
    try {
      await runCommandAndRefresh("delete_calendar_event", { id }, [loadCalendarEvents]);
    } catch (error) {
      setCalendarError(String(error));
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
      if (window.confirm(t("panel.calendar.exportConfirm", "日程已导出。是否交给系统日历导入？"))) {
        await runCommand("open_calendar_import", { path });
      }
    } catch (error) {
      setCalendarError(String(error));
    }
  }

  async function chooseCustomPetImage() {
    if (!isTauriRuntime) return;
    const path = await open({
      multiple: false,
      filters: [{ name: t("panel.settings.imageFiles", "图片文件"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
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
      setCalendarSyncNotice(t("panel.calendar.syncedToSystem", "已同步到系统日历：{count} 条").replace("{count}", String(result.pushed)));
    } catch (error) {
      setCalendarSyncNotice(t("panel.calendar.syncToSystemFailed", "同步到系统日历失败：{error}").replace("{error}", String(error)));
    }
  }

  async function syncCalendarFromSystem() {
    setCalendarSyncNotice("");
    try {
      const result = await runCommand<{ imported: number; events: CalendarEvent[] }>("sync_calendar_from_system");
      setCalendarSyncNotice(t("panel.calendar.syncedFromSystem", "已从系统日历同步：{count} 条").replace("{count}", String(result.imported)));
    } catch (error) {
      setCalendarSyncNotice(t("panel.calendar.syncFromSystemFailed", "从系统日历同步失败：{error}").replace("{error}", String(error)));
    }
  }

  async function updateFocus(command: string, args?: Record<string, unknown>) {
    setFocusState(await runCommand<FocusSnapshot>(command, args, defaultFocusSnapshot));
  }

  async function savePreferences() {
    setPreferencesStatus("");
    try {
      const settings = await runCommand<AppSettings>(
        "update_preferences",
        { input: { companionName, theme, sensingPaused } },
        { ...defaultAppSettings, companionName, theme, sensingPaused, ai: aiSettings },
      );
      setAppSettings((current) => ({
        ...current,
        companionName: settings.companionName,
        theme: settings.theme,
        sensingPaused: settings.sensingPaused,
      }));
      setPreferencesStatus(t("panel.settings.saved", "已保存"));
    } catch (error) {
      setPreferencesStatus(String(error));
    }
  }

  async function saveWorkRhythmPreferences() {
    setPreferencesStatus("");
    try {
      const settings = await runCommand<AppSettings>(
        "update_work_rhythm_preferences",
        {
          input: {
            breakRemindersEnabled,
            breakReminderIntervalMinutes,
            breakReminderCooldownMinutes,
            breakReminderQuietHoursEnabled,
            breakReminderQuietHoursStart,
            breakReminderQuietHoursEnd,
          },
        },
        {
          ...defaultAppSettings,
          breakRemindersEnabled,
          breakReminderIntervalMinutes,
          breakReminderCooldownMinutes,
          breakReminderQuietHoursEnabled,
          breakReminderQuietHoursStart,
          breakReminderQuietHoursEnd,
          ai: aiSettings,
        },
      );
      setAppSettings((current) => ({
        ...current,
        breakRemindersEnabled: settings.breakRemindersEnabled,
        breakReminderIntervalMinutes: settings.breakReminderIntervalMinutes,
        breakReminderCooldownMinutes: settings.breakReminderCooldownMinutes,
        breakReminderQuietHoursEnabled: settings.breakReminderQuietHoursEnabled,
        breakReminderQuietHoursStart: settings.breakReminderQuietHoursStart,
        breakReminderQuietHoursEnd: settings.breakReminderQuietHoursEnd,
      }));
      setPreferencesStatus(t("panel.settings.breakSaved", "休息提醒设置已保存"));
    } catch (error) {
      setPreferencesStatus(String(error));
    }
  }

  async function updateHtmlPreviewEnabled(enabled: boolean) {
    try {
      const settings = await runCommand<AppSettings>(
        "update_html_preview_enabled",
        { enabled },
        { ...defaultAppSettings, htmlPreviewEnabled: enabled, ai: aiSettings },
      );
      setAppSettings((current) => ({ ...current, htmlPreviewEnabled: settings.htmlPreviewEnabled }));
      setPreferencesStatus(t("panel.settings.htmlPreviewUpdated", "HTML 预览插件已更新"));
    } catch (error) {
      setPreferencesStatus(t("panel.settings.htmlPreviewUpdateFailed", "HTML 预览插件更新失败：{error}").replace("{error}", String(error)));
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
      setPreferencesStatus(t("panel.settings.autostartFailed", "开机启动设置失败：{error}").replace("{error}", String(error)));
    }
  }

  async function checkForUpdates() {
    setUpdateStatus(t("panel.about.checking", "正在检查更新..."));
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
      setUpdateStatus(
        update.available
          ? t("panel.about.updateAvailable", "发现新版本：{version}").replace("{version}", update.latestVersion)
          : t("panel.about.upToDate", "已是最新版本：{version}").replace("{version}", update.currentVersion),
      );
      setUpdateUrl(update.releaseUrl);
    } catch (error) {
      setUpdateStatus(t("panel.about.checkFailed", "检查更新失败：{error}").replace("{error}", String(error)));
    }
  }

  async function downloadUpdate() {
    if (!updateUrl) return;
    setIsDownloadingUpdate(true);
    setUpdateStatus(t("update.downloading", "正在下载更新..."));
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
        setUpdateStatus(t("panel.about.noAsset", "未找到可下载的安装包，请打开发布页手动下载。"));
        return;
      }
      const downloaded = await runCommand<{ filePath: string; fileName: string; downloadedBytes: number }>(
        "download_update_asset",
        { downloadUrl: update.downloadUrl, assetName: update.assetName },
      );
      setDownloadedUpdatePath(downloaded.filePath);
      setUpdateStatus(t("panel.about.downloadComplete", "下载完成：{fileName}").replace("{fileName}", downloaded.fileName));
    } catch (error) {
      setUpdateStatus(t("panel.about.downloadFailed", "更新下载失败：{error}").replace("{error}", String(error)));
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
      <header className="panel-header">
        <div>
          <p className="eyebrow">PIKO · DESKTOP COMPANION</p>
          <h1>{t("panel.companion.collectionTitle", "伙伴图鉴")}</h1>
          <p>{t("panel.companion.tagline", "一个安静待在桌面上，也会认真帮忙的小伙伴。")}</p>
        </div>
        <span className="status-pill">{t("panel.status.online", "在线")}</span>
      </header>

      <nav className="panel-tabs" aria-label={t("panel.nav.ariaLabel", "面板导航")}>
        {panelTabOptions.map(({ label, labelKey, value }) => (
          <button
            className={panelTab === value ? "is-active" : ""}
            key={value}
            type="button"
            onClick={() => setPanelTab(value)}
          >
            {t(labelKey, label)}
          </button>
        ))}
      </nav>

      <section className={panelSectionClass("companion", "companion-card")}>
        <div className="companion-card__portrait">
          <PetSprite mode="idle" emotion="happy" reaction="none" />
        </div>
        <div className="companion-card__copy">
          <p className="eyebrow">NO. 001 · DESKTOP SPIRIT</p>
          <h2>{companionName}</h2>
          <p>{t("panel.companion.description", "治愈型桌面精灵。擅长陪伴、对话和处理专注任务。")}</p>
          <div className="trait-list">
            <span>{petVisualStyleLabel}</span>
            {petVisualStyle === "character" ? <span>{live2dModelLabel}</span> : null}
            <span>{t("panel.companion.aiAssistant", "AI 助手")}</span>
          </div>
        </div>
      </section>

      <section className={panelSectionClass("companion")}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">INTERACTION</p>
            <h2>{t("panel.companion.interactionTitle", "互动档案")}</h2>
          </div>
          <strong>{Math.round(interactionStats.intimacy)} {t("panel.companion.intimacy", "亲密")}</strong>
        </div>
        <div className="status-grid">
          <div className="status-item">
            <span>{t("panel.companion.totalInteractions", "互动总数")}</span>
            <strong>{interactionStats.totalInteractions.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>{t("panel.companion.petStrokes", "摸摸次数")}</span>
            <strong>{interactionStats.petStrokeCount.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>{t("panel.companion.fileCollabs", "文件协作")}</span>
            <strong>{interactionStats.dropCount.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>{t("panel.companion.level", "当前等级")}</span>
            <strong>{growthSnapshot.level}</strong>
          </div>
        </div>
        <div className="permission-list" style={{ marginTop: "6px" }}>
          <div>
            <span>{t("panel.companion.xpProgress", "经验进度")}</span>
            <strong>{Math.round(growthSnapshot.percentage)}%</strong>
          </div>
          <div>
            <span>{t("panel.companion.bondLevel", "羁绊等级")}</span>
            <strong>{growthSnapshot.attributeLevels.bond}</strong>
          </div>
          <div>
            <span>{t("panel.companion.socialLevel", "社交等级")}</span>
            <strong>{growthSnapshot.attributeLevels.social}</strong>
          </div>
          <div>
            <span>{t("panel.companion.lastInteraction", "最近互动")}</span>
            <strong>{interactionStats.lastInteractionAt ? new Intl.DateTimeFormat("zh-CN", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }).format(interactionStats.lastInteractionAt) : t("panel.companion.none", "暂无")}</strong>
          </div>
        </div>
        <p className="empty-state">
          {t("panel.companion.xpSummary", "累计 {xp} 经验 · {tasks} 个任务进度 · {achievements} 项成就")
            .replace("{xp}", growthSnapshot.totalXp.toLocaleString("zh-CN"))
            .replace("{tasks}", String(growthSnapshot.completedTasks))
            .replace("{achievements}", String(growthSnapshot.unlockedAchievements))}
        </p>
      </section>

      <section className={panelSectionClass("about")}>
        <p className="eyebrow">PRIVACY & PERMISSIONS</p>
        <h2>{t("panel.about.permissionsTitle", "权限中心")}</h2>
        <div className="permission-list">
          <div><span>{t("panel.about.notificationPermission", "通知权限")}</span><strong>{notificationPermission}</strong></div>
          <div><span>{t("panel.about.fileAccess", "文件访问")}</span><strong>{t("panel.about.fileAccessValue", "仅主动拖入")}</strong></div>
          <div><span>{t("panel.about.screenCapture", "屏幕录制")}</span><strong>{screenCapturePermission}</strong></div>
          <div><span>{t("panel.about.sensing", "主动感知")}</span><strong>{sensingPaused ? t("panel.about.paused", "已暂停") : t("panel.about.running", "运行中")}</strong></div>
        </div>
      </section>

      <section className={panelSectionClass("about")}>
        <p className="eyebrow">BUSINESS PLUGINS</p>
        <h2>{t("panel.about.pluginsTitle", "外部插件")}</h2>
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
          <p className="empty-state">{t("panel.about.pluginsEmpty", "未发现外部插件清单。")}</p>
        )}
      </section>

      <section className={panelSectionClass("about")}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">ABOUT</p>
            <h2>{t("panel.about.versionTitle", "版本信息")}</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" onClick={() => void checkForUpdates()}>
              {t("settings.checkUpdates", "检查更新")}
            </button>
            <button type="button" disabled={!updateUrl || isDownloadingUpdate} onClick={() => void downloadUpdate()}>
              {isDownloadingUpdate ? t("panel.about.downloadingNow", "正在下载...") : t("settings.downloadUpdate", "下载更新")}
            </button>
          </div>
        </div>
        <p className="empty-state">Piko Desktop Companion · v0.1.0</p>
        {updateStatus && <p className="connection-status">{updateStatus}</p>}
        {updateUrl && (
          <button className="release-link" type="button" onClick={() => void openUrl(updateUrl)}>
            {t("panel.about.openReleasePage", "打开下载页")}
          </button>
        )}
        {downloadedUpdatePath && (
          <button className="release-link" type="button" onClick={() => void openPath(downloadedUpdatePath)}>
            {t("panel.about.openDownloadedFile", "打开已下载文件")}
          </button>
        )}
      </section>

      <section className={panelSectionClass("companion")}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">STATUS</p>
            <h2>{t("panel.status.currentTitle", "当前状态")}</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" onClick={() => runCommand("show_pet")}>{t("panel.status.showPet", "显示精灵")}</button>
            <button type="button" onClick={() => runCommand("hide_pet")}>{t("panel.status.hidePet", "隐藏精灵")}</button>
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
            <h2>{t("panel.status.rhythmTitle", "今日活跃度")}</h2>
          </div>
          <strong>{workRhythmState.isIdle ? t("panel.status.restSuggested", "建议休息") : t("panel.status.keepWorking", "继续工作")}</strong>
        </div>
        <div className="status-grid">
          <div className="status-item">
            <span>{t("panel.status.todayTyping", "今日输入")}</span>
            <strong>{workRhythmState.typingCharactersToday.toLocaleString("zh-CN")}</strong>
          </div>
          <div className="status-item">
            <span>{t("panel.status.typingDuration", "输入时长")}</span>
            <strong>{formatDuration(workRhythmState.typingSecondsToday)}</strong>
          </div>
          <div className="status-item">
            <span>{t("panel.status.foregroundApp", "前台应用")}</span>
            <strong>{workRhythmState.activeAppCategory}</strong>
          </div>
          <div className="status-item">
            <span>{t("panel.status.idleDuration", "空闲时长")}</span>
            <strong>{formatDuration(workRhythmState.idleSeconds)}</strong>
          </div>
        </div>
      </section>

      <PreferencesSection
        className={panelSectionClass("settings")}
        companionName={companionName}
        theme={theme}
        sensingPaused={sensingPaused}
        setAppSettings={setAppSettings}
        petVisualStyle={petVisualStyle}
        live2dModelId={live2dModelId}
        customPetImagePath={customPetImagePath}
        chooseCustomPetImage={chooseCustomPetImage}
        clearCustomPetImage={clearCustomPetImage}
        autostartEnabled={autostartEnabled}
        toggleAutostart={toggleAutostart}
        savePreferences={savePreferences}
        refreshOnboardingStatus={refreshOnboardingStatus}
        preferencesStatus={preferencesStatus}
      />

      <QuietModeSection
        className={panelSectionClass("settings")}
        quietMode={appSettings.quietMode}
        updateQuietMode={updateQuietMode}
      />

      <BreakReminderSection
        className={panelSectionClass("settings")}
        breakRemindersEnabled={breakRemindersEnabled}
        breakReminderIntervalMinutes={breakReminderIntervalMinutes}
        breakReminderCooldownMinutes={breakReminderCooldownMinutes}
        breakReminderQuietHoursEnabled={breakReminderQuietHoursEnabled}
        breakReminderQuietHoursStart={breakReminderQuietHoursStart}
        breakReminderQuietHoursEnd={breakReminderQuietHoursEnd}
        setAppSettings={setAppSettings}
        saveWorkRhythmPreferences={saveWorkRhythmPreferences}
      />

      <ModelProviderSection
        className={panelSectionClass("settings")}
        aiSettings={aiSettings}
        updateProvider={updateProvider}
        updateAiField={updateAiField}
        apiKey={apiKey}
        setApiKey={setApiKey}
        isTesting={isTesting}
        testConnection={testConnection}
        connectionStatus={connectionStatus}
      />

      <HtmlPreviewSection
        className={panelSectionClass("settings")}
        htmlPreviewEnabled={appSettings.htmlPreviewEnabled}
        updateHtmlPreviewEnabled={updateHtmlPreviewEnabled}
      />

      <RemindersSection
        className={panelSectionClass("reminders")}
        focusState={focusState}
        focusMinutes={focusMinutes}
        setFocusMinutes={setFocusMinutes}
        updateFocus={updateFocus}
        reminders={reminders}
        reminderTitle={reminderTitle}
        setReminderTitle={setReminderTitle}
        reminderDueAt={reminderDueAt}
        setReminderDueAt={setReminderDueAt}
        reminderRepeat={reminderRepeat}
        setReminderRepeat={setReminderRepeat}
        reminderError={reminderError}
        createReminder={createReminder}
        deleteReminder={deleteReminder}
      />

      <CalendarSection
        className={panelSectionClass("calendar")}
        calendarEvents={calendarEvents}
        calendarSyncStatus={calendarSyncStatus}
        calendarSyncNotice={calendarSyncNotice}
        calendarTitle={calendarTitle}
        setCalendarTitle={setCalendarTitle}
        calendarStartAt={calendarStartAt}
        setCalendarStartAt={setCalendarStartAt}
        calendarEndAt={calendarEndAt}
        setCalendarEndAt={setCalendarEndAt}
        calendarError={calendarError}
        calendarNotice={calendarNotice}
        createCalendarEvent={createCalendarEvent}
        deleteCalendarEvent={deleteCalendarEvent}
        exportCalendar={exportCalendar}
        syncCalendarToSystem={syncCalendarToSystem}
        syncCalendarFromSystem={syncCalendarFromSystem}
      />

      <HistorySection
        className={panelSectionClass("history")}
        focusState={focusState}
        chatHistory={chatHistory}
        filteredChatHistory={filteredChatHistory}
        selectedHistoryEntry={selectedHistoryEntry}
        historyFilter={historyFilter}
        historySearch={historySearch}
        setHistoryFilter={setHistoryFilter}
        setHistorySearch={setHistorySearch}
        setSelectedHistoryId={setSelectedHistoryId}
        clearChatHistory={clearChatHistory}
      />

      <section className={panelSectionClass("memory")}>
        <MemoryCenter />
      </section>

    </main>
  );
}
