# R1-4「设置」Tab 重组为 5 组 + 高级 · 交付报告

> 任务卡：`.sdlc/01-prd/tasks/settings-tab.md` ｜ 模块文档：`05-模块-设置与个性化.md`
> 执行环境：`/Volumes/W_W/claude-workspace/im-robot`
> 基线：`src/features/panel/tabs/SettingsTab.tsx` 整理前 1374 行（51 KB，从 `PanelWindow.tsx` 复制的半成品）

---

## 1. 改动文件列表

| 文件 | 动作 | 规模 |
| --- | --- | --- |
| `src/features/panel/tabs/SettingsTab.tsx` | **重写**（唯一主战场） | 1374 行 → **1023 行** |
| `src/features/panel/tabs/settings.css` | **新建**（任务卡指定） | 117 行，全部 `settings-` 前缀（除 `.tab--settings`） |

顶部已加 `import "./settings.css";`（SettingsTab.tsx 第 1 行）。

**未触碰**（任务卡明令禁止，coordinator 与另一个 worker 正在改）：
`PanelWindow.tsx`、`tabs/TodayTab.tsx`、`tabs/RecordsTab.tsx`、`PanelChrome.tsx`、`App.css`、`settingsStore.ts`。
用 `git status --short` 复核：这些文件均无本次改动带来的 diff（`PanelWindow.tsx` / `PanelChrome.tsx` 的 M 状态是 coordinator 的既有改动，我方未碰）。

### 顺手发现（未修，仅记录）

`src/features/panel/settingsGroup.css` 出现在 `git status` 的 untracked 列表里，但它**不在 PanelChrome.tsx 的 import 中**，也没有任何文件引用它。看着是协调方/另一 worker 的半成品。本报告未创建、也未删除它。

---

## 2. 验收命令真实输出

```console
$ npx tsc --noEmit
[exit=0]                       ← 整个仓库零输出
```

```console
$ npm run lint
...
✖ 71 problems (0 errors, 71 warnings)
```

> 71 条 warning 全部是改动前即已存在的（`no-explicit-any`、`react-hooks/set-state-in-effect` 等）。
> **`SettingsTab.tsx` 自身 0 warning**——已确认 `npm run lint | grep -A4 "tabs/SettingsTab"` 无输出。
> （对照：整理前该文件有 30+ 条 tsc 错误。）

```console
$ npm test

> im-robot@1.2.7 test
> vitest run


 RUN  v4.1.7 /Volumes/W_W/claude-workspace/im-robot


 Test Files  15 passed (15)
      Tests  147 passed (147)
   Start at  23:51:46
   Duration  274ms (transform 490ms, setup 0ms, import 691ms, tests 55ms, environment 1ms)
```

```console
$ npm run build
...
dist/assets/PanelWindow-GAZKFnNi.js    77.48 kB │ gzip: 22.19 kB
dist/assets/vendor-react-C2n9gw-S.js  202.17 kB │ gzip: 64.67 kB

✓ built in 239ms
[build exit=0]
```

```console
$ grep -c "SettingsGroup" src/features/panel/tabs/SettingsTab.tsx
13
```

> 13 = 6 个开标签 + 6 个闭标签 + 1 处 import。分组条目数用下面两条确认：

```console
$ grep -c "<SettingsGroup" src/features/panel/tabs/SettingsTab.tsx
6
$ grep -c "</SettingsGroup>" src/features/panel/tabs/SettingsTab.tsx
6
```

```console
$ grep -n "panel-overview\|OnboardingWindow\|PanelNavigation" src/features/panel/tabs/SettingsTab.tsx
[exit=1]                       ← 无任何输出
```

### 任务卡「判断标准」补充自查

```console
$ grep -in "reminder\|calendarEvent\|memo\|chatHistory\|focusState" src/features/panel/tabs/SettingsTab.tsx
18 条命中，全部是「提醒与免打扰」组里的 breakReminder* 字段：
  91-96   breakRemindersEnabled / breakReminderIntervalMinutes / breakReminderCooldownMinutes /
          breakReminderQuietHoursEnabled / breakReminderQuietHoursStart / breakReminderQuietHoursEnd
  743,744,756,757,767,768,775,776,785,786,793,794  同上 6 个字段的 JSX 读写
```

即：除了允许保留的 `breakReminder*`，`reminder` / `calendarEvent` / `memo` / `chatHistory` / `focusState` 这些残留词**一个都不剩**（原来的 `reminders`、`memoSummaries`、`calendarEvents`、`chatHistory`、`focusState` state 等全部删除）。

### 未运行的命令

按任务卡要求，**未运行 `npm run test:e2e`**（coordinator 统一跑）。

---

## 3. 最终 6 个分组

顺序与「默认展开」严格按任务卡：前 4 组 `defaultOpen`，「关于」与「高级」不传（折叠），「高级」在最后。

### 1. 伙伴 `id="companion"` · 默认展开

- 伙伴名片（`<CompanionHero>`，含「开始对话」与「换个样子」）
- 一起成长的记录（折叠卡：互动总数 / 摸摸次数 / 文件协作 / 当前等级 / 经验进度 / 羁绊等级 / 社交等级 / 最近互动 / 累计经验·任务·成就）
- 当前状态（桌面精灵 / AI 对话 / 文件处理 / 提醒 四项 + 显示精灵 / 隐藏精灵）
- 精灵名称（文本，≤24 字，即时保存）
- 主题色（鼠尾草绿 / 湖水蓝 / 暖桃色，即时保存）
- 精灵形象（机甲猫 / Piko 角色形象 / 自定义图片 / Piko 经典兜底）
- 自定义图片（选择图片 / 清除）
- 主动感知（开关，即时保存）
- 安静模式（活泼 / 平衡 / 极简 分段控件，`update_quiet_mode`）
- 安静模式说明文案

### 2. 对话与模型 `id="ai"` · 默认展开

- 服务类型（6 个预置 provider，`updateProvider` 同时套用预设 baseUrl/model）
- API Key（password 输入，本地 Ollama 可留空）
- 保存并测试连接（**动作型提交，按任务卡保留**）
- 连接状态（持久型内联文本；失败时换成 `<ErrorState>` 带「重试 / 关闭」）

### 3. 提醒与免打扰 `id="notify"` · 默认展开

- 开启休息提醒（开关）
- 提醒间隔（分钟）（15–240，步长 5）
- 提醒冷却（分钟）（5–240，步长 5）
- 启用静默时段（开关）
- 静默开始（time）
- 静默结束（time）
- 休息提醒说明文案
- 系统通知权限（只读展示：已授权 / 按需申请）
- 去开启（仅未授权时出现，`requestPermission`）

### 4. 系统与隐私 `id="system"` · 默认展开

- 开机自动启动（开关，`@tauri-apps/plugin-autostart` 的 `enable` / `disable`）

### 5. 关于 `id="about"` · **默认折叠**

- 权限中心（通知权限 / 文件访问 / 屏幕录制 / 主动感知）
- 版本信息（`v{appVersion}`，取自 `package.json`）
- 检查更新
- 下载更新
- 打开下载页（有 releaseUrl 时出现）
- 打开已下载文件（下载完成后出现）
- 重新运行引导（`reset_onboarding`；门禁渲染在 shell）

### 6. 高级 `id="advanced"` · **默认折叠，最后一个**

内部再用一层 `<details class="settings-subgroup">` 承载四小节：

- **模型参数**
  - Base URL
  - Model
  - Temperature（0–2，步长 0.1）
  - 超时秒数（5–600）
  - 保存并测试连接
- **语音**
  - 语音模型列表（名称 / 中文优化徽标 / 大小·是否已下载 / 下载进度% / 下载按钮）
  - SenseVoice 中文优化说明文案（存在未下载的 sense-voice 时出现）
  - 无模型时：`<EmptyState>`「还没有可下载的语音模型」
- **实验室**
  - HTML 预览插件（开关，`update_html_preview_enabled`）
  - 说明文案
- **插件**
  - 外部插件列表（`manifest.name` / `manifest.id` / `status`）
  - **无插件时整个小节不渲染**（任务卡：「无插件时不显示入口」）

---

## 4. 删除清单

### 4.1 删除的 import（全部确认无残留引用）

| import | 归属 |
| --- | --- |
| `{ PanelHistory, formatChatHistoryTime }` 整条 | RecordsTab（对话历史） |
| `{ CompanionHero, PanelHeader, PanelNavigation }` → 收敛为 `{ CompanionHero, SettingsGroup }` | `PanelHeader` / `PanelNavigation` 归 shell |
| `{ OnboardingWindow }` | 引导门禁归 shell |
| `{ MemoryCenter }` | RecordsTab |
| `FormEvent`、`useMemo`（`useEffect` / `useRef` / `useState` 保留） | 随残留表单删除 |
| `{ save }`（`@tauri-apps/plugin-dialog` 只留 `open`）、`openUrl`→保留、`openPath`→保留 | 随日历导出删除 |
| `runCommandAndRefresh` | 随日历/提醒/备忘的刷新链路删除 |
| `{ defaultPreferencesDraft, defaultWorkRhythmDraft }` | 仅被已删重置路径引用 |
| `defaultAiSettings` | 仅被已删的重置兜底引用 |
| `formatCalendarRange`、`formatFocusRemaining`、`formatReminderTime` | 今天/记录 |
| `reminderRepeatLabel`、`reminderRepeatOptions` | 今天（快速添加） |
| `defaultCalendarStartTime`、`defaultCalendarEndTime`、`defaultReminderTime` | 今天 |
| `countCalendarConflicts` | 记录/今天 |
| `defaultFocusSnapshot`、`defaultWorkRhythmState` | 今天 |
| 类型：`CalendarEvent`、`CalendarSyncStatus`、`ChatHistoryEntry`、`FocusSnapshot`、`Memo`、`MemoCategory`、`MemoSummaryGroup`、`OnboardingStatus`、`PanelTab`、`Reminder`、`ReminderRepeat`、`WorkRhythmState` | 分别归今天/记录/shell |

保留并仍在使用：`AppSettings`、`AiSettings`、`QuietMode`、`Theme`、`InstalledPlugin`、`ModelInfo`、`SpeechModelStatus`、`SpeechModelDownloadProgress`、`UpdateStatus`；`formatBytes`、`formatDuration`→**实际只剩 `formatBytes` 在用**（`formatDuration` 随工作节奏 UI 一并删除）；`petVisualStyleOptions`、`providerOptions`、`quietModeOptions`、`getAvailablePetVisualStyleOptions`、`usePetVisualStyle`、`useCustomPetImagePath`、`setPetVisualStyle`、`setCustomPetImagePath`、`clearCustomPetImagePath`、`defaultAppSettings`。

### 4.2 删除的 state

**今天 / 记录残留（任务卡 §「必须删掉」1）**

| state | 备注 |
| --- | --- |
| `chatHistory` / `setChatHistory` | |
| `reminders` / `setReminders` | |
| `reminderTitle`、`reminderDueAt`、`reminderRepeat` / `setReminderRepeat` | |
| `reminderError` | |
| `memos`（保留 setter 的场景已无） | 连 `setMemos` 一并删除 |
| `memoSummaries` | |
| `memoTitle`、`memoContent`、`memoCategoryFilter` / `setMemoCategoryFilter`、`editingMemoId`、`memoError` | |
| `calendarEvents`（含 `setCalendarEvents`）、`calendarTitle`、`calendarStartAt`、`calendarEndAt`、`calendarError`、`calendarNotice`、`calendarSyncStatus`、`calendarSyncNotice` | |
| `focusMinutes` / `setFocusMinutes`、`focusState` | 今日专注归「今天」Tab |
| `workRhythmState` | 03 §12 要求「输入字符 / 前台应用」从 UI 移除 |

**shell 残留**

| state | 备注 |
| --- | --- |
| `panelTab` / `setPanelTab` | 本 Tab 不再需要知道当前是哪个 Tab |
| `onboardingStatus` | 引导门禁归 `PanelWindow.tsx` |
| `mountedRef` | 只被已删的挂载 effect 使用 |
| `workspaceRef` | 滚动复位归 shell |

**其它**

| state | 备注 |
| --- | --- |
| `defaultPreferencesDraft` / `defaultWorkRhythmDraft` 的所有直接引用 | 初始值改为 `useState(() => to*Draft(settings))` |
| `speechModelProgress` — **保留** | 下载进度仍在「高级 → 语音」渲染 |
| `downloadingSpeechModelId` — **保留** | 同上 |

### 4.3 删除的 handler / loader

| 函数 | 归属 |
| --- | --- |
| `loadChatHistory`、`loadReminders`、`loadMemos`、`loadMemoSummaries`、`loadCalendarEvents`、`loadCalendarSyncStatus`、`loadWorkRhythmState` | 今天 / 记录 |
| `createReminderAndRefresh`、`createCalendarEventAndRefresh` | 今天（快速添加） |
| `clearChatHistory` | 记录（对话历史） |
| `createReminder`、`deleteReminder` | 今天 |
| `saveMemo`、`editMemo`、`cancelMemoEdit`、`deleteMemo` | 记录 |
| `createCalendarEvent`、`deleteCalendarEvent`、`exportCalendar`、`syncCalendarToSystem`、`syncCalendarFromSystem` | 今天 / 记录 |
| `updateFocus` | 今天（专注计时器） |
| `refreshOnboardingStatus` | shell（改为 `rerunOnboarding()`，只 `reset_onboarding`，不读状态、不渲染门禁） |
| `saveAiSettings` 的对外暴露面收窄 | 保留，但只被 `testConnection` 调用（任务卡：「保存并测试连接」是动作型提交） |

### 4.4 删除的 JSX / 结构

- `panel-shell` / `panel-workspace` 外壳 → 根节点改为 `<div className="tab tab--settings">`
- `panel-overview`（4 项总览：AI 对话 / 今日专注 / 亲密度 / 最近互动）
- `<PanelHeader>`、`<PanelNavigation>` 两处渲染
- `<OnboardingWindow>` 渲染及其早返回分支
- 全部 `panelTab === "..."` 条件块（`companion` / `about` / `settings` / `memos` / `calendar` / `history` / `memory` / `reminders`）
- 「今日活跃度」整块（今日输入 / 输入时长 / 前台应用 / 空闲时长）——03 §12 明确要求移除
- `memoCategoryLabels` / `memoCategoryOptions` 两个模块级常量
- `filteredMemos` 这个 `useMemo`
- 独立 `<section>` 外壳：原「个性化与系统」「互动活泼度」「休息提醒」「模型服务」「HTML 预览」5 个 `panel-card panel-section--settings` 全部拆解进新分组

### 4.5 改写（不是删除）的部分

| 原 | 现 | 原因 |
| --- | --- | --- |
| 组件名 `PanelWindow` | `SettingsTab` | 契约要求 `export function SettingsTab()`，无 props |
| `get_settings` + `listen("settings-updated")` 自建缓存 | `useAppSettings()` | 任务卡：三个 Tab 共用一份缓存，不要自己再 `get_settings` |
| `applyServerPreferences` / `applyServerWorkRhythm`（内部再广播） | `applyPreferences` / `applyWorkRhythm`（只推进本地基线） | 草稿本来就来自同一份 `AppSettings`；再 `applyServer` 会让 store 重新 publish 同一对象，把同步 effect 又唤醒一轮 |
| 连接状态恒为 `<p className="feedback-status">` | 失败时渲染 `<ErrorState>`（带重试/关闭），否则 `feedback-status` | 规范化：错误用 `ErrorState`，不新增错误样式 class |
| 语音模型空态（原先整块不渲染） | `<EmptyState icon={<Volume2/>}>` | 规范化 |
| 各处的说明性 `<p className="empty-state">` | `<p className="settings-note">`（写在 `settings.css`） | `empty-state` 是空态语义，不该当说明文案用 |
| 「外部插件」空态 `<p className="empty-state">未发现外部插件清单。</p>` | 整个小节不渲染 | 任务卡明确要求 |

---

## 5. 没做 / 做不了的事

1. **未运行 `npm run test:e2e`**（任务卡禁止）。已有的 `tests/e2e/panel-tabs.spec.ts` 里有一个针对本次结构的用例（断言 6 个 `.settings-group__title` 文案、6 个 `details.settings-group`、第 6 个不带 `open`），我按它的断言核对过实现（分组标题 / 顺序 / 折叠状态一致），但没有实际跑。
2. **未做 05 §4.4 的其余项**：全局快捷键、点击 Piko 时（切换对话 / 只做动画）、导出我的数据、清空我的数据——旧文件里没有对应 UI，任务卡「分组映射」表也没有给出要搬的 JSX，按「照这个搬，不要重新发明」未新增。因此**「系统与隐私」组目前只有「开机自动启动」一项**。
3. **未做 05 §6 的主题改造**（浅色 / 深色 / 跟随系统 + 强调色）与 **§7 的语言策略**（清理 i18n）——两者都属于产品决策，不在本任务卡范围内。主题下拉仍是原来的 3 个色值（`sage` / `blue` / `peach`），因为 `Theme` 类型与 `appShared.tsx` 都禁止我改。
4. **未做 05 §5 的「每组提供恢复默认链接」**——任务卡的分组映射表没有这一项，未新增。
5. **未新增任何单测**：`SettingsTab` 依赖 `@tauri-apps/*`、`package.json`、`lucide-react` 与浏览器 API，现成测试环境（node）跑它成本高于收益；`settingsDrafts.ts` 的校验已有既有单测覆盖，本次未改动它。
6. **`rerunOnboarding()` 只调 `reset_onboarding`**，不再读 `get_onboarding_status`。副作用：面板不会立刻弹出引导窗（shell 的 `onboarding` state 只在挂载与 `onboarding-status-updated` 事件时刷新，而 `reset_onboarding` 只发 `settings-updated`）。文案已写成「引导已重置，重新打开面板后生效。」而不是承诺立即生效——真正要「点了就弹」需要 shell 侧监听 `settings-updated` 或 `reset_onboarding` 后自己再刷一次状态，这属于 `PanelWindow.tsx`，我不碰。
7. **未修复 `src/features/panel/settingsGroup.css`**：它是 untracked 且无人 import 的孤儿文件（详见 §1），既不是我建的，也不在我的允许改动清单里。
8. **未提交 git**（与既有交付报告一致，等 coordinator 决定）。
