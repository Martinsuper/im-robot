# 安全审查

> **修复记录（2026-09-29）**：S1 已修复（CSP 已设置、asset 协议整体禁用并移除 `protocol-asset` feature、HTML 预览迁移至独立 `preview` 自定义协议并带专属 CSP）；S2 已修复（保存对话框改由后端弹出，注入脚本无法再绕过对话框直接写盘）；S3 已修复（HTTPS 强制、文件名消毒、扩展名白名单、流式下载 + 512MB 上限）；S4 已修复（fuel 计量 20M 指令 + StoreLimitsBuilder 64MB 内存上限 + 移入 spawn_blocking）。S5 待处理。
> 注意：本机缺少 Windows SDK 无法本地编译，Rust 改动需 CI 验证。

## 1. 威胁模型前提

评估安全问题的前提是理解本应用的特殊性：**webview 会渲染 AI 生成的 HTML**（HTML 预览功能，`update_html_preview_enabled`，`src-tauri/src/lib.rs:4156`）。模型输出内容不可信——被注入的页面若能在 webview 内执行脚本，就能调用暴露给前端的全部 Tauri command。因此下方"前端可触发的 command 级漏洞"不是纯理论问题，攻击链路是：模型输出恶意 HTML → 无 CSP 的 webview 内执行 → 调用任意写/读 command。

iframe 本身有 sandbox（`HtmlPreviewFrame.tsx:70`，未开 allow-same-origin）兜底，但 webview 全局没有 CSP，防线单薄。

## 2. 高危问题

### S1. CSP 为 null + asset 协议开放整个主目录

- 位置：`src-tauri/tauri.conf.json:64-70`

```json
"security": {
  "csp": null,
  "assetProtocol": { "enable": true, "scope": ["$HOME/**"] }
}
```

- 影响：`csp: null` 意味着 webview 内加载的任何脚本都不受内容安全策略约束；`assetProtocol.scope: ["$HOME/**"]` 允许前端以 `asset://` 形式读取用户主目录下任意文件。
- 组合后果：一旦有脚本注入（HTML 预览、模型输出的 markdown 图片 URL 等），即可静默读取主目录文件并把数据外传。
- 修复建议：
  1. 设置非 null CSP，至少 `default-src 'self'; img-src 'self' asset: data:; script-src 'self'`，按实际功能逐步放开。
  2. asset scope 收窄到实际需要暴露的目录（当前只有 Live2D 模型/素材加载需要 asset 协议，应指向模型目录而非整个 HOME）。

### S2. `save_generated_text` 任意路径写入

- 位置：`src-tauri/src/lib.rs:3914-3934`
- 现状：`validate_save_path`（3914-3924）只校验扩展名白名单（12 种），**完全不限制目录**——绝对路径、`..`、符号链接目标全部放行；`save_generated_text`（3926-3934）直接 `fs::write` 到前端传入的任意路径。
- 影响：webview 被注入后可把 `.py/.js/.html/.bat` 等写入用户启动目录，或覆盖任意白名单扩展名的已有文件（如配置文件）。现有测试（lib.rs:5651-5654）只验证扩展名分支。
- 修复建议：
  1. 增加基准目录（如 `app_data/exports`），前端只传相对文件名，后端 canonicalize 后校验前缀仍在基准目录内。
  2. 若必须支持用户自选路径，走 Tauri dialog 插件由用户在原生对话框中确认，后端校验对话框返回路径。
  3. 覆盖已有文件前已有确认机制，保留。

### S3. `download_update_asset` 路径逃逸 + 无完整性校验

- 位置：`src-tauri/src/lib.rs:5305-5343`
- 现状：`download_url` 与 `asset_name` 均来自前端且未消毒，`update_dir.join(&file_name)`（5335）遇绝对路径或 `..` 即逃出 updates 目录；下载内容无签名或哈希校验；整体读入内存（5328 `bytes()`，安装包上百 MB 时内存尖峰，见 [06-性能](06-performance-review.md)）。
- 影响：注入后可把任意 URL 内容写到 updates 目录之外的任意路径。
- 修复建议：
  1. 校验 `file_name` 必须是纯文件名（`Path::new(&name).file_name() == Some(...)` 且不含路径分隔符）。
  2. 下载后校验 SHA-256（发布时在 Release 附带校验和）或至少校验 Content-Length 上限。
  3. 用流式写盘（`bytes_stream()`）替代整体读入内存。
  4. 中长期：接入 Tauri 官方 updater 插件（自带签名验证），替代手写下载逻辑。

## 3. 中危问题

### S4. WASM 插件沙箱无资源限制

- 位置：`src-tauri/src/lib.rs:1156-1223`
- 现状：wasmtime 45 + WASI p1，stdin/stdout/stderr 有内存管道上限（1MB/256KB，1184-1185），未开文件系统/env/args（1187-1191），文件隔离良好。但：
  - `Engine::default()`（1169）**没有 fuel 也没有 epoch interruption**——插件里一个死循环会永久挂死调用线程；
  - 没有 `Store` 内存 limiter，插件可无上限吃内存；
  - 每次调用都重新创建 Engine 并从磁盘编译 Module（1169-1170），开销大；
  - 同步执行，经 `registry.execute`（4786）直接跑在 async `stream_chat` 里，阻塞 tokio worker。
- 修复建议：
  1. `Engine` 配置 fuel metering 或 epoch interruption，给单次调用设时限；`Store` 加 `limiter`（内存上限 + table/memory 水位）。
  2. Engine 全局复用，Module 按插件哈希缓存编译产物。
  3. 执行迁移到 `tokio::task::spawn_blocking` 或专用线程池。

### S5. 全局键盘钩子无法卸载

- 位置：`src-tauri/src/typing_activity.rs:469-486`（Windows rdev `listen`）、`421-455`（macOS CGEventTap）
- 现状：启动时无条件安装，统计所有按键（只记 delta 不记内容，无内容窃取风险，但行为模式与键盘记录器相同）；`sensing_paused` 只能停统计，不能卸载钩子。
- 影响：杀软误报率高；macOS 需要辅助功能权限；对"暂停主动感知"的用户承诺打折。
- 修复建议：`sensing_paused` 时通过 channel 让钩子线程退出（rdev listen 可通过 `WrappedType`/控制通道中断，或改用低级轮询 `GetLastInputInfo`——Windows 上该 API 无需钩子即可获得空闲时长，且完全避开杀软误报，建议优先评估替换）。

## 4. 低危问题

| # | 问题 | 位置 | 说明与建议 |
| --- | --- | --- | --- |
| L1 | `should_bypass_system_proxy` 后缀匹配可被公网域名利用 | `lib.rs:1959-1975` | `.ends_with(".local")` 会匹配公网可解析的 `evil.local`；IPv4-mapped IPv6（`::ffff:127.0.0.1`）不识别。base_url 本是用户自填，SSRF 放大有限。建议改为精确匹配 `localhost`、解析后判断 IP 是否回环/私网。 |
| L2 | Gemini API key 拼进 URL query | `lib.rs:1995-1999` | 跨域重定向时 key 可能随 URL 泄漏。建议改用 `x-goog-api-key` 请求头。 |
| L3 | HTTP redirect 用默认策略 | `lib.rs:1977-1984` | 默认最多 10 次跟随，未显式收紧。与 L2 组合时风险放大。建议 `redirect::Policy::limited(3)` 并禁止跨主机携带凭据。 |
| L4 | Cubism Core 用 `new Function` 执行 fetch 来的脚本 | `Live2DCharacterPet.tsx:86` | 等价 eval。当前资产来自本地打包，风险低；但一旦设置 CSP（S1 修复），`script-src 'self'` 会与 `new Function`（需 unsafe-eval）冲突，届时需改为普通 `<script>` 注入或打包进构建产物。 |
| L5 | 确认草稿/聊天请求 Map 缓慢累积 | `lib.rs:435` | `ActionDrafts`/`ChatRequests` 只在确认/结束时移除，未确认条目常驻内存。加过期清理（如 10 分钟）。 |

## 5. 做得好的部分

- **凭据管理**：API key 走 keyring（`lib.rs:26-42`、`1890-1912`），settings.json 只存 `has_api_key` 布尔（`lib.rs:60-93`）；导入导出脱敏（`sync/import_export.rs:12-58`）。
- **renderer 注入面**：全库无 `dangerouslySetInnerHTML` / `innerHTML` / `document.write`；外链仅 http(s) 才 `openUrl`（`BubbleWindow.tsx:39-46`）；HTML 预览 iframe `sandbox="allow-scripts allow-forms allow-modals"` 未开 allow-same-origin。
- **Tauri capabilities**：`capabilities/default.json` 仅 core:default、window:allow-start-dragging、autostart/notification/dialog/opener:default，无 fs/shell 越权。
- **TLS**：`http_client` 默认校验证书，全库无 `danger_accept_invalid`。
- **WASI 隔离**：WASM 插件无文件系统/env/args 访问，管道有内存上限。

## 6. 修复清单（按顺序）

1. `tauri.conf.json`：设置 CSP + 收窄 assetProtocol scope（S1）。
2. `validate_save_path` 加基准目录 + canonicalize 前缀校验（S2）。
3. `download_update_asset` 文件名消毒 + 哈希校验 + 流式写盘（S3）。
4. WASM 加 fuel/epoch + 内存 limiter + spawn_blocking（S4）。
5. Gemini key 移入请求头、redirect 策略收紧（L2/L3）。
6. 键盘钩子支持暂停时卸载，评估 `GetLastInputInfo` 替代方案（S5）。
