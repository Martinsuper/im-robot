# 任务卡 · R1-4 「设置」Tab 重组为 5 组 + 高级

> 由 coordinator 派发给 worker。执行前请完整阅读本文件与 `05-模块-设置与个性化.md`。

## 现状说明（重要）

`src/features/panel/tabs/SettingsTab.tsx` 是从旧的 `PanelWindow.tsx` **复制并删减**而来的半成品，
当前 `npx tsc --noEmit` 会报一批 **「声明未使用」** 与 **「类型不匹配」** 错误。
你的任务就是把它整理成一个干净、可编译的「设置」Tab。

```bash
npx tsc --noEmit 2>&1 | grep SettingsTab   # 先看一遍当前错误
```

## 目标

1. 删掉不属于本 Tab 的东西（残留的 Today / Records 状态、旧的 shell 结构、旧 Tab 枚举值）。
2. 把保留下来的设置项按 05 §4 重组为 **5 个主分组 + 1 个高级分组**。
3. 保证 `npx tsc --noEmit`、`npm run lint`、`npm run build` 全过。

## 组件契约

```tsx
export function SettingsTab(): JSX.Element   // 不接受任何 props，自带数据加载
```

- **不要**渲染 `panel-shell` / `PanelHeader` / `PanelNavigation` / `panel-overview`——
  这些归 coordinator 的 shell（`PanelWindow.tsx`）。
- **不要**渲染 `OnboardingWindow`——引导门禁也归 shell。
- 根节点用 `<div className="tab tab--settings">`。
- 设置数据统一走 `src/features/panel/settingsStore.ts` 的 `useAppSettings()` 读
  （三个 Tab 共用一份缓存，不要自己再 `get_settings`）。
  写入沿用文件里已有的 `useAutoSave` + `updatePreferences` / `updateWorkRhythm` /
  `updateQuietMode` 那套（R0-2 已验收，保留不动）。

## 分组映射（照这个搬，不要重新发明）

| 现有 JSX（行号为整理前的大致位置） | 归入分组 |
| --- | --- |
| `<CompanionHero>`（912） | **伙伴** |
| `companion-metrics-card`（916，一起成长的记录） | **伙伴** |
| `companion-status-card`（1029，当前状态） | **伙伴** |
| 「个性化与系统」（1079） | **拆开**：名字 / 主题 / 精灵形象 / 自定义图片 / 主动感知 → **伙伴**；开机自动启动 → **系统与隐私** |
| 「互动活泼度」（1151，安静模式） | **伙伴 → 安静模式**（05 §4.1） |
| 「休息提醒」（1168） | **提醒与免打扰** |
| 「模型服务」（1236） | **拆开**：服务类型 / API Key / 保存并测试连接 → **对话与模型**；Base URL / Model / Temperature / 超时秒数 / 语音模型下载 → **高级 → 模型参数 + 语音** |
| 「权限中心」（969） | **关于**（05 §4.5） |
| 「外部插件」（980） | **高级 → 插件**（无插件时不显示入口） |
| 「版本信息」（997） | **关于** |
| 「HTML 预览」（1347） | **高级 → 实验室** |

分组外壳用 `PanelChrome.tsx` 里已有的 `SettingsGroup`：

```tsx
<SettingsGroup id="companion" icon={<PawPrint size={15} />} title="伙伴" defaultOpen>
```

- 前 4 组默认展开；**「关于」与「高级」默认折叠**（`defaultOpen` 不传即折叠）。
- 「高级」必须是最后一个 `SettingsGroup`，标题写「高级」。
- 高级组内部再用一层 `<details>` 承载「模型参数 / 语音 / 实验室 / 插件」四小节。

## 必须删掉的东西

1. 所有与「今天」「记录」相关的残留：`reminders` / `calendarEvents` / `memos` /
   `chatHistory` / `focusState` / `focusMinutes` / `workRhythmState` / `memoSummaries`
   / `calendarSyncStatus` 等 state 与它们的 loader、handler、import。
2. `panel-overview` 与旧的 shell 结构（`panel-shell` / `panel-workspace` / `PanelHeader` / `PanelNavigation`）。
3. `OnboardingWindow` 的渲染与 `onboardingStatus` state（归 shell）。
4. `PanelHistory` / `MemoryCenter` 的 import（归 RecordsTab）。
5. 所有 `panelTab` 相关逻辑与 `PanelTab` 的旧取值（`"companion"` / `"reminders"` / ...）。
   本 Tab 不再需要知道当前是哪个 Tab。
6. 工作节奏（`workRhythmState`）的 UI —— 03 §12 明确要求「输入字符 / 前台应用」从 UI 移除。

> 判断标准：整理后 `grep -n "reminder\|calendarEvent\|memo\|chatHistory\|focusState" SettingsTab.tsx`
> 应当只剩「提醒与免打扰」组里合理的少量命中（例如 `breakReminder*` 字段）。
> 每删一处都要确认它不再被引用，不要留半截。

## 规范化

- 空状态用 `<EmptyState>`，错误用 `<ErrorState>` 或 `useToast().error()`，
  不要新增错误样式 class。
- 新增样式只写进 **新建的** `src/features/panel/tabs/settings.css`，
  用 `settings-` 前缀，并在文件顶部 `import "./settings.css";`。
- **不要改** `src/App.css`、`src/features/panel/PanelChrome.tsx`、`tabs/TodayTab.tsx`、
  `tabs/RecordsTab.tsx`、`PanelWindow.tsx`、`src/features/panel/settingsStore.ts`。
- 「保存并测试连接」保留（它是动作型提交，不是设置项即时保存）。
- 不要运行 `npm run test:e2e`。

## Observable acceptance（必须贴出真实输出）

```bash
npx tsc --noEmit            # 期望：整个仓库无输出
npm run lint                # 期望 0 errors
npm test                    # 期望全过
npm run build               # 期望通过
grep -c "SettingsGroup" src/features/panel/tabs/SettingsTab.tsx   # 期望 = 6
grep -n "panel-overview\|OnboardingWindow\|PanelNavigation" src/features/panel/tabs/SettingsTab.tsx  # 期望无输出
```

## 交付格式

**把结果写入 `.sdlc/01-prd/tasks/settings-tab.report.md`**：

1. 改动文件列表。
2. 上面验收命令的真实输出。
3. 最终 6 个分组的标题与各自包含的设置项清单（一项一行）。
4. 你删掉的每个 state / handler / import 的清单（便于复核没有误删仍在用的东西）。
5. 没做/做不了的事。
