# 测试覆盖审查

> **修复记录（2026-09-29）**：新增 `useTauriEventSubscription.test.tsx`（4 用例：handler 变化不重订阅、ref 透传、resolve 后卸载注销一次、resolve 前卸载注销一次——F1 的验收测试）与 `previewFrameUrl` 2 用例；vitest include 扩展到 `.test.tsx`；引入 `@testing-library/react` + `jsdom`（per-file `@vitest-environment jsdom`）。当前 12 个测试文件 101 用例全过（聊天事件流竞态 8 用例 + petAi 18 用例已补，含用例发现并推动修复的 chat_start 骨架 bug）。e2e 5/5。

## 1. 现状盘点

### 前端

- vitest：10 个测试文件、**102 用例全部通过**（2026-09-29 实测）。
- 已覆盖：`pet/` 领域纯逻辑（emotion 12、growth 17、personality 16、interaction 3、optimization 21、outfit 12、petState 8）、`appShared` 5、`Live2DCharacterPet` 6、`HtmlPreviewFrame` 2。
- e2e：Playwright，`tests/e2e/`，CI 中安装 chromium 后运行。

### 后端

- lib.rs 内嵌 `mod tests`（约 1140 行）**55 个 `#[test]`**；memory 等模块另有 9 个。
- 覆盖：位置钳制、扩展名校验、安静时段、provider URL/请求体构造、三家 SSE delta 解析、工具调用累积/合并/草稿、iCalendar 转义、声明式插件校验、提醒到期/重复、会话历史上限。
- 质量评价：纯函数单测选点准确，质量不低。

## 2. 盲区清单（T1，中）

### 前端（完全没有测试的核心逻辑）

| 类别 | 具体对象 | 规模/风险 |
| --- | --- | --- |
| 窗口组件 | PanelWindow（1448 行）、BubbleWindow（949）、PetWindow（673）、MemoryCenter（483）、CaptureWindow、OnboardingWindow | 全部业务交互入口零覆盖 |
| 数据管线 | `petAi.ts`（AI 回复解析 + 缓存）、`petSpeech.ts`、`interactionStorage.ts`、`appRuntime.ts`、`bubbleMessage.ts` | 解析逻辑出错直接影响对话 |
| 自定义 hooks | `usePetDrag`、`usePetNotice`、`useTauriEventSubscription`、`useAsyncResolved` | hooks 是当前缺陷最集中处（见 [02-前端](02-frontend-review.md) F1/F4） |
| i18n | `I18nProvider` | 仅 Onboarding 使用，风险低 |

### 后端

| 类别 | 说明 |
| --- | --- |
| `stream_chat` / HTTP 层 | 零集成测试；SSE 解析有单测但"请求构造→发送→流式回调→工具调用循环"全链路无验证 |
| `execute_wasm_plugin` | 无测试；且因无超时机制（[01-安全](01-security-review.md) S4）本身也难以安全地测 |
| `download_update_asset` | 无测试（对应任意写漏洞 S3） |
| keyring / 真实文件系统交互 | 无测试、无网络 mock 设施 |

## 3. 补测建议（按优先级）

1. **`useTauriEventSubscription` 重写时同步补测**：mock `listen()` 返回延迟 resolve 的 promise，验证（a）handler 变化不导致解绑重订阅；（b）resolve 前卸载仍会调用 unlisten。这是 F1 修复的验收测试。
2. **BubbleWindow 聊天事件流**：requestId/sequence 竞态是这个组件的核心设计（381/391 行），用 `@tauri-apps/api` mock 出乱序/交错事件，验证旧请求不会覆盖新请求的显示。
3. **`petAi.ts` 与 `interactionStorage.ts` 单测**：纯逻辑、易测、直接决定宠物对话质量，性价比最高。
4. **后端 `connection_test_body` / 新增命令**：随 `test_connection` 提交（工作区已有 1 个用例，可补 Anthropic/Gemini 分支与不支持 provider 的分支）。
5. **HTTP 层引入 mock 设施**：`wiremock`（异步、支持 SSE 流式响应）做 `stream_chat` 集成测试——正常流、中断流、非 200 错误体、工具调用回传四类用例。
6. **组件测试选型**：窗口组件如果只求冒烟覆盖，引入 `@testing-library/react` + `jsdom` 渲染冒烟即可（当前 vitest 无 environment 配置，`vitest.config.ts` 只有 138 字节）；不必追求交互全覆盖。
7. **e2e 扩展**：现有 e2e 只能测 web 预览模式（`vite preview`），对 Tauri API 依赖的部分建议用 tauri-driver（WebDriver）补一条"启动→托盘→面板打开"的冒烟，可暂缓。

## 4. 测试基础设施小问题

- `vitest.config.ts` 极简（无 environment、无 coverage 配置）。建议开启 `coverage`（`@vitest/coverage-v8`）并在 CI 输出报告，作为补测进度度量。
- `playwright.config.ts` 浏览器探测只覆盖 macOS，见 [04-工程体系](04-engineering-review.md) 第 4 节。
