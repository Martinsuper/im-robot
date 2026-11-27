# 半自动更新：定时自动检查 + 主动提醒

## Context

Piko（Tauri 2，v1.3.0）**已有完整的手动更新链路**：`src-tauri/src/app_updates.rs` 提供 GitHub Releases 检查、平台资产匹配、SHA-256 校验流式下载（带进度事件、可取消），`src/features/panel/VersionSettings.tsx` 提供「检查更新 → 下载 → 打开 dmg」UI。缺的只有「自动」一半：**没有后台定时检查，也不会主动提醒**，用户必须自己进设置点按钮。

本次新增：后台周期检查（启动 5 分钟后首次，之后每 24 小时）→ 发现新版本时在面板顶部显示横幅并发系统通知 → 用户点击进入设置页走已有的下载/安装流程。下载与安装仍由用户确认，不做静默安装。

**关键事实**（探索已确认）：
- panel UI 实际嵌在 bubble 窗口内（`bootstrap.rs:117-121` 跳过创建 panel 窗口），Rust → 面板事件必须 `emit_to("bubble", ...)`，`emit_to("panel", ...)` 是空操作。
- 事件先订阅、再查询恢复的「先订阅后对账」模式已有先例（`src/features/chat/BubbleWindow.tsx:619-638` soul 消息）。
- 新增命令必须走 `npm run contracts:generate` 代码生成（`tools/contracts`），`npm run check` 含 `contracts:check`。
- i18n 三份 locale（zh-CN/en-US/ja-JP）均为强制项；`t()` 的中文 fallback 必须与 zh-CN 值逐字节相同（`scripts/check-i18n-keys.mjs`）。

## 改动清单

### Rust 侧

**1. `src-tauri/src/app_settings.rs`** — 新增两个字段（跟随 `agent_auto_approve_commands` 的 `#[serde(default)]` 风格）：
- `auto_check_updates: bool`，`#[serde(default = "default_auto_check_updates")]`，默认 `true`；`Default` impl 与默认函数同步补充
- `skipped_update_version: String`，`#[serde(default)]`，默认空串

**2. `src-tauri/src/settings_commands.rs`** — 两个 setter，逐行仿照 `update_agent_auto_approve_commands`（128-141 行）：transaction → read_settings → 改字段 → persist_settings → 向 `["panel","pet","bubble"]` emit `settings-updated`：
- `update_auto_check_updates(app, enabled: bool)`
- `update_skipped_update_version(app, version: String)`

**3. `src-tauri/src/app_updates.rs`**：
- 新增 `static LAST_STATUS: LazyLock<Mutex<Option<UpdateStatus>>>`；`check_for_updates_extended`（201 行）成功后先写入 `LAST_STATUS` 再返回——手动检查与自动检查共用，天然覆盖。
- 新命令 `get_last_update_status() -> Result<Option<UpdateStatus>, String>`：读缓存、不发网络请求，供 webview 晚订阅时对账。
- 纯决策函数 `fn should_notify(status: &UpdateStatus, skipped_version: &str) -> bool`：`status.available && status.latest_version != skipped_version`。
- 新函数 `pub(crate) fn watch_update_checks(app: &AppHandle)`：用 `SUPERVISOR.spawn_async("update-auto-check", ...)`（仿 `memory/extraction.rs:458` 的 `worker.sleep(...).await` 异步循环 + `worker.health()`）。循环体：`worker.sleep(5 分钟)` → `read_settings` → 若 `auto_check_updates` 开启则 `check_for_updates_extended().await`；成功且 `should_notify` 时 `app.emit_to("bubble", "update-available", &status)` 并用 `SUPERVISOR.spawn_effect` 发系统通知 `crate::notifications::send(app, "Piko 有新版本", "发现新版本 v{x}，打开面板即可下载安装。")`（Rust 侧用户文案按代码库惯例硬编码中文，如 `bootstrap.rs:134`）；失败静默记 `worker.health(Err)`，下一周期重试；然后 `worker.sleep(24 小时)`。两个时长用具名常量。
- 单元测试：`should_notify` 的分支用例（可更新/已是最新/命中跳过版本），放入现有 `mod tests`。

**4. `src-tauri/src/bootstrap.rs`**：
- setup 中 `watch_work_rhythm(app.handle());`（242 行）之后追加 `crate::app_updates::watch_update_checks(app.handle());`
- `generate_handler!` 列表注册：`crate::app_updates::get_last_update_status`（290-291 行附近）、两个 settings setter（settings 区段）。

**5. 代码生成**：`npm run contracts:generate` 重新生成 `src/generated/ipc.ts`。

### 前端

**6. 类型与默认值**：
- `src/types/appTypes.ts` `AppSettings`（21-42 行）加 `autoCheckUpdates: boolean; skippedUpdateVersion: string;`
- `src/features/app/appSharedData.ts` `defaultAppSettings`（256 行）加 `autoCheckUpdates: true, skippedUpdateVersion: ""`。（`settingsStore.parseAppSettings` 用 spread，自动流过，无需改。）

**7. 新组件 `src/features/panel/UpdateBanner.tsx`**：
- 先 `listen<UpdateStatus>("update-available", ...)`（仅 `isTauriRuntime`），订阅完成后再 `runCommand("get_last_update_status")` 对账；按 `latestVersion` 去重。
- 从 `useAppSettings()` 读 `skippedUpdateVersion`；`status.available && latestVersion !== skippedUpdateVersion && !sessionDismissed` 时渲染。
- UI：置于工作区顶部的窄条卡片（复用 `.panel-card` 边框圆角风格），文案 `${t("update.available", "发现新版本")}：v{latestVersion}`，两个按钮：「查看详情」→ 调用 `onOpenSettings` prop；「跳过此版本」→ `runCommand("update_skipped_update_version", { version: status.latestVersion })` 后隐藏。
- 配套 `src/features/panel/UpdateBanner.test.tsx`（jsdom，仿 `VersionSettings.test.tsx` 的 `vi.hoisted` mock + 驱动 `listen` 回调）：事件后显示、跳过调命令并隐藏、版本命中 skipped 不显示、查看详情触发回调。

**8. `src/features/panel/PanelWindow.tsx`** — 83 行 `<PanelNavigation />` 之后挂 `<UpdateBanner onOpenSettings={() => setTab("settings")} />`（跨三个 Tab 常显）。

**9. `src/features/panel/tabs/SettingsTab.tsx`** — 「关于与更新」subgroup（922 行 `<VersionSettings />` 上方）新增开关卡片，行结构仿 autostart（818-835 行 `setting-toggle` + `settings-note`），保存逻辑仿 `updateAgentAutoApproveCommands`（373-408 行）的乐观更新 + 回滚：checkbox 切换 → `runCommand("update_auto_check_updates", { enabled })` → `applyServer(parseAppSettings(next))`。

**10. i18n** — 三个 locale 的 `update.*` 块（各 256-271 行处）追加：`autoCheck`（「自动检查更新」）、`autoCheckNote`（说明文案：开启后每天联网检查一次…）、`viewDetails`（「查看详情」）、`skipVersion`（「跳过此版本」）。zh-CN 值必须与代码里 `t()` 第二参 fallback 逐字节一致；en/ja 同步翻译。

### 不改动
下载/校验/打开 dmg 链路、CI release.yml（直接消费 Releases API，无需 manifest）、不做静默安装。

## 验证

1. `npm run contracts:generate && npm run check`（含 contracts:check、i18n 键校验、版本一致性、架构边界）
2. `npm run lint && npm test`
3. `cd src-tauri && cargo test`（含新增 `should_notify` 用例）
4. 手动端到端（`npm run dev`）：
   - 设置 → 关于与更新：切换「自动检查更新」，确认写入 `app-settings.json` 且重进页面状态保持
   - 因当前 1.3.0 高于线上最新 release，横幅默认不会出现——临时把 `src-tauri/Cargo.toml` `version` 改为 `1.0.0` 重跑 dev，将两个时长常量临时调小，确认：横幅自动出现 + 收到系统通知 → 「查看详情」跳到设置页「关于与更新」→ 点「跳过此版本」后横幅不再出现（设置里 skippedUpdateVersion 已写入）→ 手动「检查更新」流程不受影响
   - 验完恢复版本号与常量
