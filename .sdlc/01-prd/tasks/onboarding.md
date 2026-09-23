# 任务卡 · R2-4 引导（Onboarding）重做

> 由 coordinator 派发给 worker。执行前请完整阅读本文件与 `05-模块-设置与个性化.md` 第 3 节。

## 目标

首次启动 **3 步内可用，且可以完全跳过**；不出现任何技术字段。

## 要改的文件

| 文件 | 动作 |
| --- | --- |
| `src/features/onboarding/OnboardingWindow.tsx` | 重写（当前是 4 步 + 独立的 provider 列表 + 暴露 Base URL/Model） |
| `src/features/onboarding/onboarding.css` | 新建（你新增的样式只写这里） |

**不要碰**：`src/features/app/providerPresets.ts`（已由 coordinator 建好，直接用）、
`src/features/panel/tabs/SettingsTab.tsx`、`src/features/panel/tabs/TodayTab.tsx`、
`src/features/panel/tabs/RecordsTab.tsx`、`src/features/chat/*`、`src/App.css`。
另一个 worker 正在改别的文件。

## 必须共用的两份东西

```ts
// 唯一的 provider 预设来源（08 §2 FN-6：现状有两份互相矛盾的列表）
import { providerPresets, findProviderPreset } from "../app/providerPresets";
```

```ts
// 错误文案人话化（R0-1 已落地）
import { toUserMessage } from "../../lib/errors";
```

## 目标流程（05 §3.2）

```text
步骤 1 / 3  欢迎 + 给 Piko 起名
            [ 名字输入框（默认 Piko）]
            [ 继续 ]   [ 以后再说 ]

步骤 2 / 3  连接 AI（可跳过）
            选择服务： [ OpenAI ▼ ]（用 providerPresets）
            API Key： [ ............ ]
            [ 测试连接 ]  →  成功 / 失败（人话原因）
            [ 完成 ]   [ 跳过，先用本地的 ]

步骤 3 / 3  认识一下
            ✔ 点击 Piko 就能聊天
            ✔ 拖文件给它可以帮你读
            ✔ 说「提醒我…」它会记住
            [ 开始使用 ]
```

## 硬性约束

1. **不出现 Base URL / Model / Temperature / Timeout**。这些属于「设置 → 高级」（02 §10.2）。
   选择服务后，Base URL 与默认模型由 `providerPresets` 自动带上，不展示给用户。
2. **本机服务（`needsApiKey: false`，如 Ollama / LM Studio）不显示 API Key 输入框**，
   改为一句「跑在你自己电脑上，不需要 Key」，并允许模型名留空。
3. **任何一步都可跳过**。跳过时用合理默认（保留 `defaultAiSettings` 的既有值即可，不要写坏数据）。
4. 测试连接失败的文案必须是人话：走 `toUserMessage`，
   并且对「连不上本机端口」这种情况给出可行动的提示（例如
   「无法连接本机 11434 端口，请确认 Ollama 已启动」——022 §10.3 明确要求）。
5. **引导只运行一次**；「设置 → 关于」里已有「重新运行引导」，不要重复实现。
6. 完成后**直接打开对话窗口空状态**（`runCommand("show_bubble")`），让用户立刻体验价值。
7. 不要引入新的 npm 依赖。

## 保留现有的命令与数据流

现状的这几处调用方式**不要改**（后端已验收）：

```ts
runCommand<OnboardingStatus>("get_onboarding_status", ...)   // 由 PanelWindow 外壳负责判断
runCommand("complete_onboarding", { input: { companionName, onboardingVersion } })
runCommand("update_ai_settings", { input: { provider, baseUrl, model, apiKey, temperature, timeoutSeconds } })
runCommand("reset_onboarding", ...)
```

`OnboardingWindow` 的 props 保持 `{ onComplete: () => void; onSkip: () => void }`，
由 `PanelWindow.tsx` 传入——**不要**改 `PanelWindow.tsx`。

## Observable acceptance（必须贴出真实输出）

```bash
npx tsc --noEmit            # 期望无输出
npm run lint                # 期望 0 errors
npm run build               # 期望通过
npm test                    # 期望全过

# 引导页不得再出现自己的 provider 列表
grep -n "PROVIDERS" src/features/onboarding/OnboardingWindow.tsx     # 期望无输出
# 不得暴露技术字段
grep -niE "baseUrl|temperature|timeout" src/features/onboarding/OnboardingWindow.tsx | grep -v providerPresets
#    期望：只在命令参数里出现，不在任何 label / 可见文案里
```

另外请自测一次：`npm run build && npx playwright test tests/e2e/panel-tabs.spec.ts`
确认没有把面板弄坏（引导只在 `required: true` 时显示，预览环境下不会出现）。

不要运行 `npm run test:e2e` 的全量。

## 交付格式

**把结果写入 `.sdlc/01-prd/tasks/onboarding.report.md`**：

1. 改动文件列表。
2. 上面验收命令的真实输出。
3. 三步各自的可见文案（逐条列出，方便核对没有技术术语）。
4. 「本机服务」分支的截图或 DOM 结构说明（说明为什么没有 Key 输入框）。
5. 没做/做不了的事。
