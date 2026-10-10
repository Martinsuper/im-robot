# 前端审查（src/）

> **修复记录（2026-09-29）**：F1 已修复（hook 重写：handler 走 ref、deps 只留 eventName、无条件 dispose，附 4 个验收测试）；F3 已修复（新增 `runCommandQuiet` / `reportCommandError`，全部 fire-and-forget 与 `.then` 链补齐错误上报，MemoryCenter 吞错改为展示 `error` 状态）；F4 已修复（mountedRef 守卫全部改为无条件 dispose、scheduleFidget 重写为可取消的自续链、PanelWindow 每秒轮询删除、MemoryCenter 防抖清理、PetWindow 注意脉冲改推导状态）；F5 已修复（PetDomainContext 快照改为事件驱动刷新，修复 bondTier 冻结；MemoryCenter 搜索加请求序号防竞态）。其余 16 个 ESLint error（react-hooks v7 set-state-in-effect / purity / refs）已全部清零。
> F2 已完成（2026-10-01）：12 个 settings useState 合并为 useAppSettings hook 后，History/Reminders/Calendar/Settings
四个大 tab 抽取为 src/features/panel/sections/ 组件（HistorySection 143 行、RemindersSection 131 行、
CalendarSection 114 行、SettingsSection 394 行含 5 个子组件 + chatHistoryFilters.ts 50 行），
PanelWindow 1423→954 行、render JSX 减 57%，状态与 handler 保留在 PanelWindow，DOM/选择器不变，
tsc/eslint/75 单测/build/e2e 全绿。companion 与 about 的小段（<60 行/段）未抽，收益为负。F7 已完成。F6、双通道待处理。

技术栈：React 19 + TypeScript（strict 全开）+ Vite。以下问题均给出 `file:line` 证据。

## 1. 结构问题

### F2. PanelWindow.tsx 上帝组件（高）

- `features/panel/PanelWindow.tsx`：**1448 行**、45+ 个 `useState`（115-180 行）、40+ 个内联 async 函数，设置、提醒、日历、专注、历史、更新、外部插件、onboarding 全部内聚在一个组件。
- settings 同步逻辑写了两遍：初始 `get_settings` 拆 11 个 setXxx（273-288 行），`settings-updated` 事件再拆 11 个 setXxx（333-346 行），极易漂移。
- 次一级的大文件：`BubbleWindow.tsx` 949 行（聊天流/附件/截图/TTS/保存/动作确认/历史/HTML 预览，但已做子组件拆分，尚可维护）；`PetWindow.tsx` 673 行；`appShared.tsx` 636 行（常量 + localStorage hooks + PetSprite 组件 + 格式化函数混在一起）；`LiveCharacterPet.tsx` 561 行（约 260 行是图集坐标常量，应抽成数据文件）。

**修复建议**：
1. 按 tab 拆 PanelWindow 为独立组件，各 tab 自管状态。
2. 11 个 settings state 合并为单一对象 state，抽 `useAppSettings()` hook，加载与事件更新共用同一 setter，消除两份同步代码。
3. appShared 按职责拆为 constants / hooks / components / format 四个文件。

## 2. React 缺陷

### F1. useTauriEventSubscription 重订阅与永久泄漏（高）

- 位置：`features/pet/hooks/useTauriEventSubscription.ts:42-61`
- 问题一：handler 在依赖数组里（61 行 `[eventName, handler, ...deps]`），PetWindow 传入内联箭头函数（`PetWindow.tsx:271`、`300`），**每次渲染都解绑再重订阅** Tauri 事件。
- 问题二：竞态——cleanup 先于 `listen()` promise resolve 执行时 `unlistenRef.current` 为 null，且 resolve 后因 `cancelled=true` 不保存 unlisten（46-50 行），**监听器永久泄漏、事件重复触发**。

**修复建议**：重写该 hook——handler 存进 ref（每渲染更新 ref.current），deps 只留 eventName；cleanup 用 `Promise.resolve(promise).then(u => u())` 无条件 dispose，不依赖 mounted 标志。此修复同时解决 F4 中大部分 listen 泄漏。

### F4. 其余监听器与 timer 清理缺陷（中）

| 问题 | 位置 |
| --- | --- |
| listen 清理用 `mountedRef.current` 条件跳过 dispose，卸载早于 promise resolve 时泄漏 | `PanelWindow.tsx:359-361`、`BubbleWindow.tsx:350-352/370-372/435-437` |
| `scheduleFidget` 递归重排的新 timer 不被 effect cleanup 追踪；内层 `fidgetResetTimer` 的 `clearTimeout` 写在 setTimeout 回调里完全不生效；闭包捕获过期 `petState.mode` | `PetWindow.tsx:219-235`、`411-415` |
| PanelWindow 每秒 `setInterval(get_focus_state, 1000)` 轮询，与 `focus-updated` 事件推送重复 | `PanelWindow.tsx:347-349` |
| copyFeedback 的 setTimeout 未清理；历史朗读不跟踪 `onend`/isSpeaking | `BubbleWindow.tsx:572`、`193-199` |
| MemoryCenter 搜索防抖 timer 未随卸载清理 | `MemoryCenter.tsx:33`、`133-136` |

### F5. 状态与数据流缺陷（中）

- **PetDomainContext 快照冻结**：`const [growthSnapshot] = useState(...)`（`PetDomainContext.tsx:116-121`）没有 setter，`bondTier` 永远是挂载时的值，导致宠物语音/行为分级失真；221-237 行的 storage 监听回调是空函数（死代码）。
- **同窗口事件双通道**：`appShared.tsx:167-173` 的 setter 同时 dispatch DOM CustomEvent 又 `emit` Tauri 事件，同窗口收到两次通知、setState 两次（244-246 行消费端）。建议单窗口内只走 DOM CustomEvent，跨窗口才走 Tauri emit。
- **MemoryCenter 搜索竞态**：`searchMemories`（`MemoryCenter.tsx:107-129`）无请求序号保护，防抖 300ms 只缓解不消除，慢响应可覆盖新结果。参照 `BubbleWindow.tsx:381/391` 的 `activeRequestId` + sequence 方案补齐。
- **PetWindow 重复读 localStorage**：每次交互同步 `loadInteractionStats()` 三次，各做一次 JSON.parse（`PetWindow.tsx:140-142`）。

### F3. 错误处理为零（高）

- 全库 100 处 `runCommand` 调用、**0 处 `.catch`**；fire-and-forget 的 `void runCommand(...)` 至少 14 处必然产生 unhandled rejection：`PetWindow.tsx:197/201/514/526`、`BubbleWindow.tsx:566`、`PanelWindow.tsx:398/1000`、`CaptureWindow.tsx:29` 等。
- `MemoryCenter` 吞错：5 个加载函数 `catch { setMemories([]) }`（54-60、63-71、73-91 行），失败时用户看到"还没有记忆"而非报错。
- 正面例子（保持）：PanelWindow 表单错误展示、`testConnection` 展示失败原因（430-442）、BubbleWindow `failed` 事件显示 message（425-431）。

**修复建议**：给 `appRuntime.ts` 的 `runCommand` 加统一错误策略——或提供 `runCommandSafe` 返回 Result 风格对象，或在模块级注册全局错误 toast；`void runCommand` 全部替换为 safe 版本。

## 3. 类型安全

- 基础好：tsconfig `strict` + `noUnusedLocals/Parameters` + `noFallthroughCasesInSwitch` 全开；invoke 统一经 `runCommand<T>` 有类型（`appRuntime.ts:5-7`）。
- 缺陷点：
  - `any` 共 5 处：`PetDomainContext.tsx:96/203`（`signal: any`）、`useTauriEventSubscription.ts:74`、`PerformanceMonitor.ts:152`、`GrowthManager.ts:184`。
  - 断言造假：`MemoryCenter.tsx:22` `[] as unknown as T`（对 `export_memories` 这类对象返回值是谎言）；`PetWindow.tsx:504` `(files[0] as unknown as { path: string }).path`。
  - `OnboardingWindow.tsx:50-106` 裸 `invoke` 无类型，未走 `runCommand`。
  - Live2DCharacterPet 多处 `window as unknown as {...}` 调试全局——可接受但应集中声明到一个 `global.d.ts`。

## 4. 资源管理

- **WebGL 上下文乘数（中）**：每个 `PetSprite` 实例独立 `new Application()` + 独立 Live2D 模型（`appShared.tsx:432-449`、`Live2DCharacterPet.tsx:306`）；BubbleWindow 同屏可挂 5+ 个 PetSprite（755、219、174、809/843/850 行），逼近浏览器 ~8-16 个 WebGL 上下文上限。详见 [06-性能](06-performance-review.md)。
- **做得好**：Live2D 清理完整（destroy model/app、ticker remove、clearInterval、ResizeObserver disconnect，`Live2DCharacterPet.tsx:250-269`、`438-441`）；TTS 卸载时正确 cancel（`BubbleWindow.tsx:334-340`）；petAudio AudioContext 单例（应用生命周期内不 close 可接受）。

## 5. i18n 现状（F6）

- 三份 locale（`src/locales/` zh-CN / en-US / ja-JP）经脚本核对 **121 个 key 完全同步，0 缺失**。
- 但 **i18n 基本是摆设**：全库只有 `OnboardingWindow.tsx:27` 使用 `useTranslation`；其余所有窗口硬编码中文（`PanelWindow.tsx:66-73`、`appShared.tsx:64-69/531-571`、`MemoryCenter.tsx` 全部、`PetWindow.tsx:575-607`、`BubbleWindow.tsx:273-276`），且没有语言切换 UI。
- **决断建议**：要么承认当前只做中文、删掉 locale 目录减少维护负担；要么排期全面接入并加语言切换。维持现状最差——三份文件必然持续腐化。

## 6. 死代码（F7）

以下代码无任何应用侧引用（仅自身 index/test 引用），约 1300 行，仍被打包与维护：

| 代码 | 位置 | 行数 |
| --- | --- | --- |
| `pet/optimization/`（ObjectPool / TextureCache / PerformanceMonitor / RenderOptimizer） | `src/features/pet/optimization/` | ~560 |
| `pet/outfit/`（换装系统含测试） | `src/features/pet/outfit/` | ~700 |
| `EmotionManager`、`MoodManager`（全库 `new` 仅命中测试文件） | `src/features/pet/emotion/` | 部分 |
| `useTauriEventSubscriptions`（复数版） | `useTauriEventSubscription.ts:73` | ~30 |

处理建议：直接删除（git 可恢复）；若属规划中功能，移出构建路径（排除出 tsconfig/vite）并标注。

## 7. 低优先级打磨

- `LiveCharacterPet` fallback rAF 恒 60fps 重绘不按需暂停（`LiveCharacterPet.tsx:532-535`）。
- PanelWindow 渲染期每条记录新建 `Intl.DateTimeFormat`（92-99 行，应模块级复用）；历史筛选计数每渲染 O(n×6) 全表扫描（1370-1379 行）。
- `window.confirm` 做覆盖/清空确认（`BubbleWindow.tsx:724`、`PanelWindow.tsx:526`、`MemoryCenter.tsx:196`）——功能可用，观感与应用风格不符，可换成应用内确认卡片。
