import { FormEvent, useEffect, useMemo, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { OnboardingWindow } from "../onboarding/OnboardingWindow";
import { MemoryCenter } from "../memory/MemoryCenter";
import type {
  AiSettings,
  AppSettings,
  CalendarEvent,
  CalendarSyncStatus,
  ChatHistoryEntry,
  DesktopItem,
  DesktopOrganizePlan,
  DesktopOrganizeResult,
  FocusSnapshot,
  InstalledPlugin,
  ModelInfo,
  OnboardingStatus,
  PanelTab,
  QuietMode,
  Reminder,
  ReminderRepeat,
  Theme,
  UpdateStatus,
  WorkRhythmState,
} from "../../types/appTypes";
import {
  PetSprite,
  countCalendarConflicts,
  defaultAiSettings,
  defaultAppSettings,
  defaultCalendarEndTime,
  defaultCalendarStartTime,
  defaultFocusSnapshot,
  defaultDesktopOrganizePlan,
  defaultDesktopOrganizeResult,
  defaultReminderTime,
  defaultWorkRhythmState,
  formatDuration,
  formatCalendarRange,
  formatFocusRemaining,
  formatReminderTime,
  panelTabOptions,
  providerOptions,
  quietModeOptions,
  reminderRepeatLabel,
  reminderRepeatOptions,
} from "../app/appShared";
import { isTauriRuntime, runCommand, runCommandAndRefresh } from "../app/appRuntime";

export function PanelWindow() {
  const [panelTab, setPanelTab] = useState<PanelTab>("companion");
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [aiSettings, setAiSettings] = useState<AiSettings>(defaultAiSettings);
  const [companionName, setCompanionName] = useState("Piko");
  const [theme, setTheme] = useState<Theme>("sage");
  const [sensingPaused, setSensingPaused] = useState(false);
  const [breakRemindersEnabled, setBreakRemindersEnabled] = useState(true);
  const [breakReminderIntervalMinutes, setBreakReminderIntervalMinutes] = useState(45);
  const [breakReminderCooldownMinutes, setBreakReminderCooldownMinutes] = useState(30);
  const [breakReminderQuietHoursEnabled, setBreakReminderQuietHoursEnabled] = useState(false);
  const [breakReminderQuietHoursStart, setBreakReminderQuietHoursStart] = useState("22:00");
  const [breakReminderQuietHoursEnd, setBreakReminderQuietHoursEnd] = useState("08:00");
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
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
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
  const [desktopItems, setDesktopItems] = useState<DesktopItem[]>([]);
  const [desktopItemsError, setDesktopItemsError] = useState("");
  const [desktopOrganizePlan, setDesktopOrganizePlan] = useState<DesktopOrganizePlan>(defaultDesktopOrganizePlan);
  const [desktopOrganizePlanError, setDesktopOrganizePlanError] = useState("");
  const [desktopOrganizeResult, setDesktopOrganizeResult] = useState<DesktopOrganizeResult>(
    defaultDesktopOrganizeResult,
  );
  const [desktopOrganizeBusy, setDesktopOrganizeBusy] = useState(false);
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [focusState, setFocusState] = useState<FocusSnapshot>(defaultFocusSnapshot);
  const [workRhythmState, setWorkRhythmState] = useState<WorkRhythmState>(defaultWorkRhythmState);
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
  const panelSectionClass = (tab: PanelTab, base = "panel-card") =>
    `${base}${panelTab === tab ? "" : " is-hidden"}`;

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

  async function loadDesktopItems() {
    setDesktopItemsError("");
    try {
      const items = await runCommand<DesktopItem[]>("list_desktop_items", undefined, []);
      setDesktopItems(items);
    } catch (error) {
      setDesktopItems([]);
      setDesktopItemsError(String(error));
    }
  }

  async function buildDesktopOrganizePlan() {
    setDesktopOrganizePlanError("");
    setDesktopOrganizeResult(defaultDesktopOrganizeResult);
    try {
      const plan = await runCommand<DesktopOrganizePlan>(
        "build_desktop_organize_plan",
        undefined,
        defaultDesktopOrganizePlan,
      );
      setDesktopOrganizePlan(plan);
    } catch (error) {
      setDesktopOrganizePlan(defaultDesktopOrganizePlan);
      setDesktopOrganizePlanError(String(error));
    }
  }

  async function executeDesktopOrganizePlan() {
    if (!desktopOrganizePlan.id) return;
    if (!window.confirm("确认执行桌面整理？文件将按预览方案移动。")) return;

    setDesktopOrganizeBusy(true);
    setDesktopOrganizePlanError("");
    try {
      const result = await runCommand<DesktopOrganizeResult>(
        "execute_desktop_organize_plan",
        { input: { planId: desktopOrganizePlan.id } },
        defaultDesktopOrganizeResult,
      );
      setDesktopOrganizeResult(result);
      setDesktopOrganizePlan((current) => ({ ...current, status: "completed" }));
      await loadDesktopItems();
    } catch (error) {
      setDesktopOrganizePlanError(String(error));
      setDesktopOrganizeResult(defaultDesktopOrganizeResult);
    } finally {
      setDesktopOrganizeBusy(false);
    }
  }

  async function openDesktopPath(path: string) {
    setDesktopItemsError("");
    try {
      await runCommand("open_path", { path });
    } catch (error) {
      setDesktopItemsError(String(error));
    }
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
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setQuietMode(settings.quietMode);
      setAiSettings(settings.ai);
      setCompanionName(settings.companionName);
      setTheme(settings.theme);
      setSensingPaused(settings.sensingPaused);
      setBreakRemindersEnabled(settings.breakRemindersEnabled);
      setBreakReminderIntervalMinutes(settings.breakReminderIntervalMinutes);
      setBreakReminderCooldownMinutes(settings.breakReminderCooldownMinutes);
      setBreakReminderQuietHoursEnabled(settings.breakReminderQuietHoursEnabled);
      setBreakReminderQuietHoursStart(settings.breakReminderQuietHoursStart);
      setBreakReminderQuietHoursEnd(settings.breakReminderQuietHoursEnd);
      setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
      setConnectionStatus(settings.hasApiKey ? "已配置密钥" : "等待测试");
    });
    void loadChatHistory();
    void loadReminders();
    void loadCalendarEvents();
    void loadCalendarSyncStatus();
    void loadWorkRhythmState();
    void loadDesktopItems();
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
    const unlistenDesktopItems = listen("desktop-items-updated", () => {
      void loadDesktopItems();
    });
    const unlistenDesktopPlan = listen<DesktopOrganizePlan>("desktop-organize-planned", (event) => {
      setDesktopOrganizePlan(event.payload);
    });
    const unlistenDesktopCompleted = listen<DesktopOrganizeResult>(
      "desktop-organize-completed",
      (event) => {
        setDesktopOrganizeResult(event.payload);
        setDesktopOrganizePlan((current) => ({ ...current, status: "completed" }));
      },
    );
    const unlistenTyping = listen("typing-stats-updated", () => {
      void loadWorkRhythmState();
    });
    const unlistenFocus = listen<FocusSnapshot>("focus-updated", (event) => {
      setFocusState(event.payload);
    });
    const unlistenSettings = listen<AppSettings>("settings-updated", (event) => {
      setQuietMode(event.payload.quietMode);
      setAiSettings(event.payload.ai);
      setCompanionName(event.payload.companionName);
      setTheme(event.payload.theme);
      setSensingPaused(event.payload.sensingPaused);
      setBreakRemindersEnabled(event.payload.breakRemindersEnabled);
      setBreakReminderIntervalMinutes(event.payload.breakReminderIntervalMinutes);
      setBreakReminderCooldownMinutes(event.payload.breakReminderCooldownMinutes);
      setBreakReminderQuietHoursEnabled(event.payload.breakReminderQuietHoursEnabled);
      setBreakReminderQuietHoursStart(event.payload.breakReminderQuietHoursStart);
      setBreakReminderQuietHoursEnd(event.payload.breakReminderQuietHoursEnd);
      setHtmlPreviewEnabled(event.payload.htmlPreviewEnabled);
    });
    const refreshFocus = window.setInterval(() => {
      void runCommand<FocusSnapshot>("get_focus_state", undefined, defaultFocusSnapshot).then(setFocusState);
    }, 1000);
    return () => {
      void unlisten.then((dispose) => dispose());
      void unlistenHistory.then((dispose) => dispose());
      void unlistenCalendar.then((dispose) => dispose());
      void unlistenCalendarSync.then((dispose) => dispose());
      void unlistenWorkRhythm.then((dispose) => dispose());
      void unlistenDesktopItems.then((dispose) => dispose());
      void unlistenDesktopPlan.then((dispose) => dispose());
      void unlistenDesktopCompleted.then((dispose) => dispose());
      void unlistenTyping.then((dispose) => dispose());
      void unlistenFocus.then((dispose) => dispose());
      void unlistenSettings.then((dispose) => dispose());
      window.clearInterval(refreshFocus);
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
      setConnectionStatus(`连接失败：${String(error)}`);
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
      if (window.confirm("日程已导出。是否交给系统日历导入？")) {
        await runCommand("open_calendar_import", { path });
      }
    } catch (error) {
      setCalendarError(String(error));
    }
  }

  async function syncCalendarToSystem() {
    setCalendarSyncNotice("");
    try {
      const result = await runCommand<{ pushed: number; mappingCount: number }>("sync_calendar_to_system");
      setCalendarSyncNotice(`已同步到系统日历：${result.pushed} 条`);
    } catch (error) {
      setCalendarSyncNotice(`同步到系统日历失败：${String(error)}`);
    }
  }

  async function syncCalendarFromSystem() {
    setCalendarSyncNotice("");
    try {
      const result = await runCommand<{ imported: number; events: CalendarEvent[] }>("sync_calendar_from_system");
      setCalendarSyncNotice(`已从系统日历同步：${result.imported} 条`);
    } catch (error) {
      setCalendarSyncNotice(`从系统日历同步失败：${String(error)}`);
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
      setCompanionName(settings.companionName);
      setTheme(settings.theme);
      setSensingPaused(settings.sensingPaused);
      setPreferencesStatus("已保存");
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
      setBreakRemindersEnabled(settings.breakRemindersEnabled);
      setBreakReminderIntervalMinutes(settings.breakReminderIntervalMinutes);
      setBreakReminderCooldownMinutes(settings.breakReminderCooldownMinutes);
      setBreakReminderQuietHoursEnabled(settings.breakReminderQuietHoursEnabled);
      setBreakReminderQuietHoursStart(settings.breakReminderQuietHoursStart);
      setBreakReminderQuietHoursEnd(settings.breakReminderQuietHoursEnd);
      setPreferencesStatus("休息提醒设置已保存");
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
      setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
      setPreferencesStatus("HTML 预览插件已更新");
    } catch (error) {
      setPreferencesStatus(`HTML 预览插件更新失败：${String(error)}`);
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
      setPreferencesStatus(`开机启动设置失败：${String(error)}`);
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
      setUpdateStatus(`检查更新失败：${String(error)}`);
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
      setUpdateStatus(`更新下载失败：${String(error)}`);
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
          <h1>伙伴图鉴</h1>
          <p>一个安静待在桌面上，也会认真帮忙的小伙伴。</p>
        </div>
        <span className="status-pill">在线</span>
      </header>

      <nav className="panel-tabs" aria-label="面板导航">
        {panelTabOptions.map(({ label, value }) => (
          <button
            className={panelTab === value ? "is-active" : ""}
            key={value}
            type="button"
            onClick={() => setPanelTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className={panelSectionClass("companion", "companion-card")}>
        <div className="companion-card__portrait">
          <PetSprite />
        </div>
        <div className="companion-card__copy">
          <p className="eyebrow">NO. 001 · DESKTOP SPIRIT</p>
          <h2>{companionName}</h2>
          <p>像素型桌面精灵。擅长陪伴、对话和处理专注任务。</p>
          <div className="trait-list">
            <span>像素系</span>
            <span>AI 助手</span>
          </div>
        </div>
      </section>

      <section className={panelSectionClass("about")}>
        <p className="eyebrow">PRIVACY & PERMISSIONS</p>
        <h2>权限中心</h2>
        <div className="permission-list">
          <div><span>通知权限</span><strong>{notificationPermission}</strong></div>
          <div><span>文件访问</span><strong>仅主动拖入</strong></div>
          <div><span>屏幕录制</span><strong>{screenCapturePermission}</strong></div>
          <div><span>主动感知</span><strong>{sensingPaused ? "已暂停" : "未启用持续感知"}</strong></div>
        </div>
      </section>

      <section className={panelSectionClass("about")}>
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

      <section className={panelSectionClass("about")}>
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
        <p className="empty-state">Piko Desktop Companion · v0.1.0</p>
        {updateStatus && <p className="connection-status">{updateStatus}</p>}
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

      <section className={panelSectionClass("companion")}>
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

      <section className={panelSectionClass("settings")}>
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
          <p className="connection-status">{connectionStatus}</p>
        </div>
      </section>

      <section className={panelSectionClass("settings")}>
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

      <section className={panelSectionClass("settings")}>
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

      <section className={panelSectionClass("settings")}>
        <p className="eyebrow">WORK RHYTHM</p>
        <h2>休息提醒</h2>
        <div className="settings-form">
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={breakRemindersEnabled}
              onChange={(event) => setBreakRemindersEnabled(event.currentTarget.checked)}
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
                onChange={(event) => setBreakReminderIntervalMinutes(Number(event.currentTarget.value))}
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
                onChange={(event) => setBreakReminderCooldownMinutes(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={breakReminderQuietHoursEnabled}
              onChange={(event) => setBreakReminderQuietHoursEnabled(event.currentTarget.checked)}
            />
            <span>启用静默时段</span>
          </label>
          <div className="settings-form__row">
            <label>
              <span>静默开始</span>
              <input
                type="time"
                value={breakReminderQuietHoursStart}
                onChange={(event) => setBreakReminderQuietHoursStart(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>静默结束</span>
              <input
                type="time"
                value={breakReminderQuietHoursEnd}
                onChange={(event) => setBreakReminderQuietHoursEnd(event.currentTarget.value)}
              />
            </label>
          </div>
          <button type="button" onClick={() => void saveWorkRhythmPreferences()}>
            保存休息提醒设置
          </button>
          <p className="empty-state">提醒会根据今日输入、空闲状态和前台场景自动判断，只在适合的时候发声。</p>
        </div>
      </section>

      <section className={panelSectionClass("settings")}>
        <p className="eyebrow">PREFERENCES</p>
        <h2>个性化与系统</h2>
        <div className="settings-form">
          <label>
            <span>精灵名称</span>
            <input
              value={companionName}
              maxLength={24}
              onChange={(event) => setCompanionName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>主题色</span>
            <select value={theme} onChange={(event) => setTheme(event.currentTarget.value as Theme)}>
              <option value="sage">鼠尾草绿</option>
              <option value="blue">湖水蓝</option>
              <option value="peach">暖桃色</option>
            </select>
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={sensingPaused}
              onChange={(event) => setSensingPaused(event.currentTarget.checked)}
            />
            <span>暂停主动感知</span>
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={autostartEnabled}
              onChange={() => void toggleAutostart()}
            />
            <span>开机自动启动</span>
          </label>
          <button type="button" onClick={() => void savePreferences()}>
            保存个性化设置
          </button>
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
          {preferencesStatus && <p className="connection-status">{preferencesStatus}</p>}
        </div>
      </section>

      <section className={panelSectionClass("settings")}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">DESKTOP ACCESS</p>
            <h2>桌面概览</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" onClick={() => void loadDesktopItems()}>
              刷新
            </button>
          </div>
        </div>
        <p className="empty-state">仅列出桌面当前可见项目，打开操作会调用系统默认应用。</p>
        {desktopItemsError && <p className="reminder-error">{desktopItemsError}</p>}
        {desktopItems.length ? (
          <ul className="history-list">
            {desktopItems.map((item) => (
              <li key={item.path}>
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.itemType} · {item.category}
                  </span>
                </div>
                <button type="button" onClick={() => void openDesktopPath(item.path)}>
                  打开
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">桌面当前没有可列出的项目，或桌面目录暂时不可访问。</p>
        )}
      </section>

      <section className={panelSectionClass("settings")}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">DESKTOP PLAN</p>
            <h2>整理计划预览</h2>
          </div>
          <div className="section-heading__actions">
            <button type="button" onClick={() => void buildDesktopOrganizePlan()}>
              生成计划
            </button>
          </div>
        </div>
        <p className="empty-state">这里只生成预览，不会移动任何文件。确认后再进入执行步骤。</p>
        {desktopOrganizePlanError && <p className="reminder-error">{desktopOrganizePlanError}</p>}
        {desktopOrganizePlan.id ? (
          <div className="panel-plan">
            <div className="section-heading">
              <div>
                <p className="eyebrow">EXECUTION</p>
                <h3>{desktopOrganizePlan.status === "completed" ? "整理已完成" : "准备执行"}</h3>
              </div>
              <div className="section-heading__actions">
                <button
                  type="button"
                  disabled={desktopOrganizeBusy || desktopOrganizePlan.status === "completed"}
                  onClick={() => void executeDesktopOrganizePlan()}
                >
                  {desktopOrganizeBusy ? "正在执行..." : desktopOrganizePlan.status === "completed" ? "已执行" : "确认执行"}
                </button>
              </div>
            </div>
            <div className="status-grid">
              <div className="status-item">
                <span>计划 ID</span>
                <strong>{desktopOrganizePlan.id}</strong>
              </div>
              <div className="status-item">
                <span>移动数量</span>
                <strong>{desktopOrganizePlan.plannedMoves.length}</strong>
              </div>
              <div className="status-item">
                <span>创建文件夹</span>
                <strong>{desktopOrganizePlan.createdFolders.length}</strong>
              </div>
              <div className="status-item">
                <span>跳过项目</span>
                <strong>{desktopOrganizePlan.skippedItems.length}</strong>
              </div>
            </div>
            {desktopOrganizePlan.createdFolders.length > 0 && (
              <>
                <p className="eyebrow">将创建的文件夹</p>
                <ul className="history-list">
                  {desktopOrganizePlan.createdFolders.map((folder) => (
                    <li key={folder}>
                      <strong>{folder}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {desktopOrganizePlan.plannedMoves.length > 0 && (
              <>
                <p className="eyebrow">计划移动</p>
                <ul className="history-list">
                  {desktopOrganizePlan.plannedMoves.map((move) => (
                    <li key={`${move.from}-${move.to}`}>
                      <div>
                        <strong>{move.from}</strong>
                        <span>{move.category}</span>
                      </div>
                      <span>{move.to}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {desktopOrganizePlan.skippedItems.length > 0 && (
              <>
                <p className="eyebrow">已跳过</p>
                <ul className="history-list">
                  {desktopOrganizePlan.skippedItems.map((item) => (
                    <li key={item}>
                      <strong>{item}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(desktopOrganizeResult.movedCount > 0 || desktopOrganizeResult.errors.length > 0) && (
              <>
                <p className="eyebrow">执行结果</p>
                <div className="status-grid">
                  <div className="status-item">
                    <span>实际移动</span>
                    <strong>{desktopOrganizeResult.movedCount}</strong>
                  </div>
                  <div className="status-item">
                    <span>执行跳过</span>
                    <strong>{desktopOrganizeResult.skippedCount}</strong>
                  </div>
                  <div className="status-item">
                    <span>执行创建</span>
                    <strong>{desktopOrganizeResult.createdFolders.length}</strong>
                  </div>
                  <div className="status-item">
                    <span>执行错误</span>
                    <strong>{desktopOrganizeResult.errors.length}</strong>
                  </div>
                </div>
                {desktopOrganizeResult.errors.length > 0 && (
                  <ul className="history-list">
                    {desktopOrganizeResult.errors.map((error) => (
                      <li key={error}>
                        <strong>{error}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="empty-state">还没有生成整理计划。</p>
        )}
      </section>

      <section className={panelSectionClass("reminders")}>
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
        {reminderError && <p className="reminder-error">{reminderError}</p>}
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

      <section className={panelSectionClass("calendar")}>
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
        {calendarSyncNotice && <p className="calendar-notice">{calendarSyncNotice}</p>}
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
        {calendarError && <p className="reminder-error">{calendarError}</p>}
        {calendarNotice && <p className="calendar-notice">{calendarNotice}</p>}
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

      <section className={panelSectionClass("history")}>
        <div className="focus-summary">
          <span>今日专注</span>
          <strong>{focusState.todayMinutes} 分钟</strong>
        </div>
        <div className="section-heading">
          <div>
            <p className="eyebrow">CHAT HISTORY</p>
            <h2>最近对话</h2>
          </div>
          <button type="button" disabled={!chatHistory.length} onClick={() => void clearChatHistory()}>
            清除历史
          </button>
        </div>
        {chatHistory.length ? (
          <ul className="history-list">
            {chatHistory.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.prompt}</strong>
                <span>{entry.response || "没有返回文本"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">暂无对话历史。</p>
        )}
      </section>

      <section className={panelSectionClass("memory")}>
        <MemoryCenter />
      </section>

    </main>
  );
}
