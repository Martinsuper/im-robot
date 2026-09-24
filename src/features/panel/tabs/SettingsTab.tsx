import "./settings.css";
import { useEffect, useRef, useState } from "react";
import { BellRing, Info, MessageCircle, PawPrint, ShieldCheck, SlidersHorizontal, Volume2 } from "lucide-react";
import { version as appVersion } from "../../../../package.json";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CompanionHero, SettingsGroup } from "../PanelChrome";
import { EmptyState, ErrorState } from "../../../components/feedback/States";
import { useToast, type ToastTone } from "../../../components/feedback/toastStore";
import { toUserMessage } from "../../../lib/errors";
import { useAutoSave } from "../../../hooks/useAutoSave";
import { useAppSettings } from "../settingsStore";
import {
  isWorkRhythmDraftValid,
  toPreferencesDraft,
  toWorkRhythmDraft,
  type PreferencesDraft,
  type WorkRhythmDraft,
} from "../settingsDrafts";
import {
  loadGrowthSnapshot,
  loadInteractionStats,
  type GrowthSnapshot,
  type InteractionStats,
} from "../../pet/interaction";
import type {
  AiSettings,
  AppSettings,
  InstalledPlugin,
  ModelInfo,
  QuietMode,
  SpeechModelDownloadProgress,
  SpeechModelStatus,
  Theme,
  UpdateStatus,
} from "../../../types/appTypes";
import {
  clearCustomPetImagePath,
  defaultAppSettings,
  formatBytes,
  getAvailablePetVisualStyleOptions,
  petVisualStyleOptions,
  providerOptions,
  quietModeOptions,
  setCustomPetImagePath,
  setPetVisualStyle,
  useCustomPetImagePath,
  usePetVisualStyle,
} from "../../app/appShared";
import { isTauriRuntime, runCommand } from "../../app/appRuntime";

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

/**
 * 「设置」Tab（05 模块）。
 *
 * 只负责设置本身：分组、控件、即时保存。面板外壳（导航 / 主题 / 引导门禁）与
 * 「今天」「记录」的业务都住在别处，本文件不持有任何与它们有关的状态。
 *
 * 数据读取统一走 `useAppSettings()`（三个 Tab 共用一份缓存）；写入沿用
 * `useAutoSave` + `update_preferences` / `update_work_rhythm_preferences` /
 * `update_quiet_mode` 那套即时保存。
 */
export function SettingsTab() {
  const toast = useToast();
  const { settings } = useAppSettings();
  const autoSave = useAutoSave();

  // 偏好与休息提醒改为「草稿 + 已保存基线」两个来源：
  // 只有服务端返回值会更新基线，用户改动只动草稿，自动保存因此不会误判。
  const [preferences, setPreferences] = useState<PreferencesDraft>(() => toPreferencesDraft(settings));
  const preferencesRef = useRef(preferences);
  const savedPreferencesRef = useRef(preferences);
  const { companionName, theme, sensingPaused } = preferences;
  const [workRhythm, setWorkRhythm] = useState<WorkRhythmDraft>(() => toWorkRhythmDraft(settings));
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

  const [quietMode, setQuietMode] = useState<QuietMode>(settings.quietMode);
  const [aiSettings, setAiSettings] = useState<AiSettings>(settings.ai);
  const [htmlPreviewEnabled, setHtmlPreviewEnabled] = useState(settings.htmlPreviewEnabled);

  const [apiKey, setApiKey] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("尚未测试连接");
  const [isTesting, setIsTesting] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [isSavingShortcut, setIsSavingShortcut] = useState(false);
  /** 两段式确认：第一次点击只变成「确认清空」，再点才执行（00 §5.9 可逆原则）。 */
  const [confirmClear, setConfirmClear] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState("按需申请");
  const [screenCapturePermission, setScreenCapturePermission] = useState("截图时按需申请");
  const [preferencesStatus, setPreferencesStatus] = useState("");
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateUrl, setUpdateUrl] = useState("");
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState("");
  const [isDownloadingUpdate, setIsDownloadingUpdate] = useState(false);
  const [speechModels, setSpeechModels] = useState<SpeechModelStatus[]>([]);
  const [speechModelProgress, setSpeechModelProgress] = useState<Record<string, SpeechModelDownloadProgress>>({});
  const [downloadingSpeechModelId, setDownloadingSpeechModelId] = useState("");
  const [speechModelNotice, setSpeechModelNotice] = useState("");
  const [externalPlugins, setExternalPlugins] = useState<InstalledPlugin[]>([]);
  const [interactionStats, setInteractionStats] = useState<InteractionStats>(() => loadInteractionStats());
  const [growthSnapshot, setGrowthSnapshot] = useState<GrowthSnapshot>(() => loadGrowthSnapshot());

  const petVisualStyle = usePetVisualStyle();
  const customPetImagePath = useCustomPetImagePath();
  const availablePetVisualStyleOptions = getAvailablePetVisualStyleOptions(Boolean(customPetImagePath));
  const petVisualStyleLabel = petVisualStyleOptions.find((option) => option.value === petVisualStyle)?.label ?? "机甲猫";
  const appearanceSelectRef = useRef<HTMLSelectElement>(null);

  /**
   * 共享缓存 → 本地草稿的单向同步。
   *
   * 为什么需要：`useAppSettings()` 的缓存是异步加载的（也可能被别处写入，
   * 例如设置窗口/托盘），控件必须跟着走，否则会显示默认值。
   * 为什么不无条件覆盖：偏好与休息提醒是即时保存，用户输入与保存回包会交错。
   * 「草稿 !== 基线」正好等价于「还有未落盘的编辑」，此时不动草稿，避免把用户
   * 刚敲进去的字符回退。
   */
  const appliedSettingsRef = useRef<AppSettings | null>(null);
  useEffect(() => {
    if (appliedSettingsRef.current === settings) return;
    const isFirstLoad = appliedSettingsRef.current === null;
    appliedSettingsRef.current = settings;

    if (isFirstLoad || preferencesRef.current === savedPreferencesRef.current) {
      applyPreferences(settings);
    }
    if (isFirstLoad || workRhythmRef.current === savedWorkRhythmRef.current) {
      applyWorkRhythm(settings);
    }
    setQuietMode(settings.quietMode);
    setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
    // AI 参数是显式保存（「保存并测试连接」），服务端回包之外只在首次加载同步。
    if (isFirstLoad) {
      setAiSettings(settings.ai);
      setConnectionStatus(settings.hasApiKey ? "已配置密钥" : "等待测试");
    }
  }, [settings]);

  /**
   * 瞬时状态 → Toast 桥接。
   * 这 3 个 state 只用于一次性反馈（已保存 / 失败 / 正在下载…），没有内联渲染点。
   */
  useEffect(() => {
    const channels = [
      { value: updateStatus, tone: toneFromStatus(updateStatus), reset: () => setUpdateStatus("") },
      { value: preferencesStatus, tone: toneFromStatus(preferencesStatus), reset: () => setPreferencesStatus("") },
      { value: speechModelNotice, tone: toneFromStatus(speechModelNotice, "success"), reset: () => setSpeechModelNotice("") },
    ];
    const pending = channels.filter((channel) => channel.value);
    if (!pending.length) return;
    for (const channel of pending) {
      toast.show({ message: channel.value, tone: channel.tone });
      channel.reset();
    }
  }, [preferencesStatus, speechModelNotice, toast, updateStatus]);

  // 本 Tab 自己持有的两段数据：语音模型（高级 → 语音）与外部插件（高级 → 插件）。
  useEffect(() => {
    void loadSpeechModels();
    void runCommand<InstalledPlugin[]>("list_external_plugins", undefined, []).then(setExternalPlugins);
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
    const refreshInteraction = () => {
      setInteractionStats(loadInteractionStats());
      setGrowthSnapshot(loadGrowthSnapshot());
    };
    const unlistenInteraction = listen("piko-interaction-stats-changed", refreshInteraction);
    const unlistenGrowth = listen("piko-growth-state-changed", refreshInteraction);
    window.addEventListener("storage", refreshInteraction);
    return () => {
      void unlistenSpeechModelProgress.then((dispose) => dispose());
      void unlistenInteraction.then((dispose) => dispose());
      void unlistenGrowth.then((dispose) => dispose());
      window.removeEventListener("storage", refreshInteraction);
    };
  }, []);

  /**
   * 服务端返回的设置是唯一权威值（00 §5.8）：只有这里会推进「已保存基线」。
   *
   * 不调 `applyServer`：草稿本来就是从同一份 `AppSettings` 收敛出来的，再广播一次
   * 会让 store 重新 publish 同一个对象，从而把上面那条 effect 又唤醒一轮。写入命令
   * 都已在服务端落库，其它 Tab 由 `settings-updated` 事件驱动。
   */
  function applyPreferences(next: AppSettings) {
    const draft = toPreferencesDraft(next);
    savedPreferencesRef.current = draft;
    preferencesRef.current = draft;
    setPreferences(draft);
  }

  function applyWorkRhythm(next: AppSettings) {
    const draft = toWorkRhythmDraft(next);
    savedWorkRhythmRef.current = draft;
    workRhythmRef.current = draft;
    setWorkRhythm(draft);
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
        onSuccess: applyPreferences,
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
        onSuccess: applyWorkRhythm,
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
    const next = await runCommand<AppSettings>(
      "update_ai_settings",
      { input: { ...aiSettings, apiKey: apiKey || undefined } },
      { ...defaultAppSettings, ai: aiSettings },
    );
    setAiSettings(next.ai);
    setApiKey("");
    return next;
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

  /** 动作型提交：AI 参数是唯一需要点按钮才生效的一组（05 §1「没有保存按钮」的例外）。 */
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

  /**
   * 导出我的数据（05 §4.4）。
   *
   * `export_to_file` 会写一份包含设置 / 对话 / 提醒 / 日程 / 专注记录的 JSON。
   * 注意它**不含 API Key**（密钥存在钥匙串里），这一点在界面上要说清楚，
   * 否则用户会以为导出的是完整备份。
   */
  /**
   * R4-2：修改全局快捷键。
   * 失败时后端会回滚并给人话原因，这里把错误显示出来即可。
   */
  async function saveGlobalShortcut() {
    const next = (shortcutDraft ?? "").trim();
    if (!next) return;
    setIsSavingShortcut(true);
    try {
      await runCommand("update_global_shortcut", { shortcut: next });
      setShortcutDraft(null);
      toast.success("快捷键已更新");
    } catch (error) {
      toast.error(toUserMessage(error, "快捷键更新失败，请重试。"));
      setShortcutDraft(null);
    } finally {
      setIsSavingShortcut(false);
    }
  }

  async function clearMyData() {
    setIsClearing(true);
    try {
      const result = await runCommand<{ backupDir: string; cleared: string[] }>("clear_my_data", undefined, {
        backupDir: "",
        cleared: [],
      });
      toast.show({
        message: `已清空 ${result?.cleared.length ?? 0} 类数据，备份在 backups 目录`,
        tone: "success",
      });
      setConfirmClear(false);
      // 记录 Tab 监听 memos-updated / chat-history-updated，会自己刷新

    } catch (error) {
      toast.error(toUserMessage(error, "清空失败，未做任何删除。"));
    } finally {
      setIsClearing(false);
    }
  }

  async function exportMyData() {
    try {
      const path = await save({
        defaultPath: "piko-export.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await runCommand("export_to_file", { filePath: path });
      toast.show({ message: "数据已导出（不含 API Key）", tone: "success" });
    } catch (error) {
      toast.error(toUserMessage(error, "导出失败，请重试。"));
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

  async function enableNotifications() {
    if (!isTauriRuntime) return;
    try {
      if (await isPermissionGranted()) {
        setNotificationPermission("已授权");
        return;
      }
      const permission = await requestPermission();
      setNotificationPermission(permission === "granted" ? "已授权" : "按需申请");
    } catch (error) {
      setPreferencesStatus(`通知权限申请失败：${toUserMessage(error)}`);
    }
  }

  async function updateHtmlPreviewEnabled(enabled: boolean) {
    try {
      const next = await runCommand<AppSettings>(
        "update_html_preview_enabled",
        { enabled },
        { ...defaultAppSettings, htmlPreviewEnabled: enabled, ai: aiSettings },
      );
      setHtmlPreviewEnabled(next.htmlPreviewEnabled);
      setPreferencesStatus("HTML 预览插件已更新");
    } catch (error) {
      setPreferencesStatus(`HTML 预览插件更新失败：${toUserMessage(error)}`);
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

  /** 「关于 → 重新运行引导」。门禁本身在 shell（PanelWindow），这里只负责重置。 */
  async function rerunOnboarding() {
    try {
      await runCommand<AppSettings>("reset_onboarding", undefined, {
        ...defaultAppSettings,
        companionName,
        ai: aiSettings,
      });
      setPreferencesStatus("引导已重置，重新打开面板后生效。");
    } catch (error) {
      setPreferencesStatus(`重置引导失败：${toUserMessage(error)}`);
    }
  }

  const lastInteractionLabel = interactionStats.lastInteractionAt
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(interactionStats.lastInteractionAt)
    : "暂无";

  const statuses: Array<[string, string]> = [
    ["桌面精灵", "在线"],
    ["AI 对话", connectionStatus],
    ["文件处理", "可用"],
    ["提醒", "可用"],
  ];

  return (
    <div className="tab tab--settings">
      <SettingsGroup
        id="companion"
        icon={<PawPrint size={15} />}
        title="伙伴"
        description="名字、外观与它有多爱说话"
        defaultOpen
      >
        <CompanionHero
          companionName={companionName}
          styleLabel={petVisualStyleLabel}
          onAppearance={() => {
            appearanceSelectRef.current?.scrollIntoView({ block: "nearest" });
            appearanceSelectRef.current?.focus();
          }}
        />

        <details className="panel-card companion-metrics-card">
          <summary>
            一起成长的记录 <span>Lv. {growthSnapshot.level} · {Math.round(interactionStats.intimacy)} 亲密</span>
          </summary>
          <div className="companion-metrics-detail">
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
            <p className="settings-note">
              累计 {growthSnapshot.totalXp.toLocaleString("zh-CN")} 经验 · {growthSnapshot.completedTasks} 个任务进度 ·{" "}
              {growthSnapshot.unlockedAchievements} 项成就
            </p>
          </div>
        </details>

        <section className="panel-card companion-status-card">
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
        </section>

        <section className="panel-card">
          <p className="eyebrow">PREFERENCES</p>
          <h2>名字与外观</h2>
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
                ref={appearanceSelectRef}
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
          </div>
        </section>

        <section className="panel-card">
          <p className="eyebrow">PERSONALITY</p>
          <h2>安静模式</h2>
          <div className="settings-form">
            <div className="segmented-control" aria-label="安静模式">
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
            <p className="settings-note">安静：只在被叫到时回应；活泼：会主动找你说话。</p>
          </div>
        </section>
      </SettingsGroup>

      <SettingsGroup
        id="ai"
        icon={<MessageCircle size={15} />}
        title="对话与模型"
        description="用哪个服务、能不能连上"
        defaultOpen
      >
        <section className="panel-card">
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
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                placeholder="本地 Ollama 可留空"
              />
            </label>
            <button type="button" disabled={isTesting} onClick={() => void testConnection()}>
              {isTesting ? "正在测试..." : "保存并测试连接"}
            </button>
            {connectionStatus.startsWith("连接失败") ? (
              <ErrorState
                message={connectionStatus}
                onRetry={() => void testConnection()}
                onDismiss={() => setConnectionStatus("尚未测试连接")}
              />
            ) : (
              <p className="feedback-status">{connectionStatus}</p>
            )}
          </div>
        </section>
      </SettingsGroup>

      <SettingsGroup
        id="notify"
        icon={<BellRing size={15} />}
        title="提醒与免打扰"
        description="什么时候它该闭嘴"
        defaultOpen
      >
        <section className="panel-card">
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
            <p className="settings-note">提醒会根据今日输入、空闲状态和前台场景自动判断，只在适合的时候发声。</p>
          </div>
        </section>

        <section className="panel-card">
          <p className="eyebrow">NOTIFICATIONS</p>
          <h2>通知权限</h2>
          <div className="settings-form">
            <div className="settings-readonly">
              <span>系统通知</span>
              <strong>{notificationPermission}</strong>
            </div>
            {notificationPermission === "已授权" ? null : (
              <button type="button" onClick={() => void enableNotifications()}>
                去开启
              </button>
            )}
          </div>
        </section>
      </SettingsGroup>

      <SettingsGroup
        id="system"
        icon={<ShieldCheck size={15} />}
        title="系统与隐私"
        description="开机、驻留与你的数据"
        defaultOpen
      >
        <section className="panel-card">
          <p className="eyebrow">SYSTEM</p>
          <h2>开机与驻留</h2>
          <div className="settings-form">
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={autostartEnabled}
                onChange={() => void toggleAutostart()}
              />
              <span>开机自动启动</span>
            </label>
          </div>
        </section>

        <section className="panel-card">
          <p className="eyebrow">SHORTCUT</p>
          <h2>全局快捷键</h2>
          <div className="settings-form">
            <label>
              <span>打开对话窗口</span>
              <input
                value={shortcutDraft ?? settings.globalShortcut}
                onChange={(event) => setShortcutDraft(event.currentTarget.value)}
                placeholder="CmdOrCtrl+Shift+Space"
                aria-label="全局快捷键"
              />
            </label>
            {shortcutDraft !== null && shortcutDraft !== settings.globalShortcut ? (
              <div className="settings-subgroup">
                <button type="button" onClick={() => void saveGlobalShortcut()} disabled={isSavingShortcut}>
                  {isSavingShortcut ? "保存中…" : "保存快捷键"}
                </button>
                <button type="button" className="text-action" onClick={() => setShortcutDraft(null)}>
                  取消
                </button>
              </div>
            ) : null}
            <p className="settings-note">被别的应用占用时保存会失败，并自动恢复原快捷键。</p>
          </div>
        </section>

        <section className="panel-card">
          <p className="eyebrow">DATA</p>
          <h2>我的数据</h2>
          <div className="settings-form">
            <button type="button" onClick={() => void exportMyData()}>
              导出我的数据
            </button>
            <p className="settings-note">
              导出一份 JSON（设置、对话、提醒、日程、专注记录）。出于安全考虑，
              API Key 不在其中。
            </p>
          </div>
        </section>

        <section className="panel-card">
          <p className="eyebrow">DANGER</p>
          <h2>清空我的数据</h2>
          <div className="settings-form">
            <p className="settings-note">
              清空提醒、日程、备忘、对话与专注记录。会先自动备份，可从
              backups 目录找回。设置与 Piko 记住的内容不受影响。
            </p>
            {confirmClear ? (
              <div className="settings-subgroup">
                <button type="button" disabled={isClearing} onClick={() => void clearMyData()}>
                  {isClearing ? "清空中…" : "确认清空"}
                </button>
                <button type="button" className="text-action" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmClear(true)}>
                清空我的数据…
              </button>
            )}
          </div>
        </section>
      </SettingsGroup>

      <SettingsGroup id="about" icon={<Info size={15} />} title="关于" description="版本、更新与权限状态">
        <section className="panel-card">
          <p className="eyebrow">PRIVACY & PERMISSIONS</p>
          <h2>权限中心</h2>
          <div className="permission-list">
            <div><span>通知权限</span><strong>{notificationPermission}</strong></div>
            <div><span>文件访问</span><strong>仅主动拖入</strong></div>
            <div><span>屏幕录制</span><strong>{screenCapturePermission}</strong></div>
            <div><span>主动感知</span><strong>{sensingPaused ? "已暂停" : "运行中"}</strong></div>
          </div>
        </section>

        <section className="panel-card">
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
          <p className="settings-note">Piko Desktop Companion · v{appVersion}</p>
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

        <section className="panel-card">
          <p className="eyebrow">ONBOARDING</p>
          <h2>重新运行引导</h2>
          <div className="settings-form">
            <button type="button" onClick={() => void rerunOnboarding()}>
              重新运行引导
            </button>
            <p className="settings-note">重新走一遍起名与连接 AI 的流程。</p>
          </div>
        </section>
      </SettingsGroup>

      <SettingsGroup id="advanced" icon={<SlidersHorizontal size={15} />} title="高级" description="一般不用改">
        <details className="settings-subgroup">
          <summary>模型参数</summary>
          <div className="settings-form">
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
            <button type="button" disabled={isTesting} onClick={() => void testConnection()}>
              {isTesting ? "正在测试..." : "保存并测试连接"}
            </button>
          </div>
        </details>

        <details className="settings-subgroup">
          <summary>语音</summary>
          {speechModels.length ? (
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
              {speechModels.some((model) => model.id === "sense-voice" && !model.downloaded) ? (
                <p className="settings-note">
                  「SenseVoice 中文优化」—— 阿里 FunAudioLLM 出品，专为中文设计，字错率比 Whisper 低一半以上，且几乎不出繁体字。
                </p>
              ) : null}
            </div>
          ) : (
            <EmptyState
              icon={<Volume2 size={20} />}
              title="还没有可下载的语音模型"
              description="连接成功后这里会列出可用模型。"
            />
          )}
        </details>

        <details className="settings-subgroup">
          <summary>实验室</summary>
          <div className="feature-toggle-card">
            <label className="setting-toggle">
              <input
                type="checkbox"
                checked={htmlPreviewEnabled}
                onChange={(event) => void updateHtmlPreviewEnabled(event.currentTarget.checked)}
              />
              <span>HTML 预览插件</span>
            </label>
            <p className="settings-note">开启后，气泡窗口会在检测到 HTML 片段时优先使用沙箱 iframe 预览。</p>
          </div>
        </details>

        {externalPlugins.length ? (
          <details className="settings-subgroup">
            <summary>插件</summary>
            <ul className="history-list">
              {externalPlugins.map((plugin) => (
                <li key={plugin.manifest.id}>
                  <strong>{plugin.manifest.name}</strong>
                  <span>{plugin.manifest.id} · {plugin.status}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </SettingsGroup>
    </div>
  );
}
