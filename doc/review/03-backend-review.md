# 后端审查（src-tauri/）

> **修复记录（2026-09-29）**：B2 已修复（`MemoryDb`/`CandidateCache` 改为 `Arc` 管理，`build_context`/`auto_capture_from_chat`/`append_chat_history`/插件执行全部移入 `spawn_blocking`）；B3 已修复（settings 进程内 mtime 缓存，读路径命中缓存不再读盘，写盘成功同步缓存/失败失效）。B1 进行中（2026-09-30）：已拆出 4 个模块并逐个经双平台 CI 验证——settings.rs（类型+缓存+keyring）、
providers.rs（URL/HTTP 客户端/SSE 解析/工具调用累积，351 行）、updates.rs（GitHub Releases 检查+受控下载，261 行）、
tts.rs（本地语音，93 行）。lib.rs 从 6719 行降至 6268 行。
**剩余模块的耦合注意**：reminders/calendar 的结构体字段被插件系统、聊天工具调用、导入导出大量直接访问，
抽取时需先把 Reminder/CalendarEvent 字段改 pub(crate) 并迁移输入结构体；rhythm/capture 的状态类型
（FocusTimer/ScreenCaptureStore 等）由 lib.rs builder 管理，可保持 manage 不动、仅迁移函数。
B4（thiserror 错误体系）建议随各模块抽取同步进行。

技术栈：Tauri 2 + Rust。全后端共 11307 行，以下问题均给出 `file:line` 证据。安全问题见 [01-安全](01-security-review.md)，本篇聚焦结构与工程质量。

## 1. lib.rs 规模与拆分（B1，高）

### 现状

| 文件 | 行数 |
| --- | --- |
| **lib.rs** | **6719**（占后端 59%） |
| memory/store.rs | 1257 |
| sync/calendar_sync.rs | 652 |
| typing_activity.rs | 518 |
| memory/commands.rs | 463 |
| sync/import_export.rs | 422 |
| memory/reflection.rs / writer.rs / model.rs | 407 / 326 / 286 |
| app_awareness/mod.rs | 185 |
| 其余（constants/main/mod） | ~35 |

lib.rs 含 **71 个 `#[tauri::command]`**（memory/commands.rs 另有约 30 个），混杂至少 13 个领域：

| 领域 | 参考位置（lib.rs） |
| --- | --- |
| 窗口/拖拽定位 | 2082-2440 |
| 截图 | 2440-2620 |
| 设置持久化 + keyring | 955-1090、1866-1912 |
| 三 provider 适配（OpenAI/Anthropic/Gemini） | 1914-2090、4210-4610 |
| SSE 流式聊天 + 工具调用协议 | 1348-1740、4599-4983 |
| 提醒 | 2790-2845、3222-3360 |
| 日程 + iCalendar | 2846-3095 |
| 插件 trait/注册表/声明式校验 | 404-880、1091-1225 |
| WASM 执行 | 1156-1223 |
| 专注计时 + 休息提醒 | 3369-3760 |
| 空闲检测 | 3758-3870 |
| TTS 子进程 | 2705-2789 |
| 更新检查 + GitHub API + 资产下载 | 2624-2663、5198-5343 |
| 托盘 + 全局快捷键 | 5345-5402 |
| onboarding | 4998-5056 |

### 拆分建议

`memory/`、`sync/` 已经拆出去了，证明模式可行。建议第一轮机械拆分（大部分是自由函数，挪文件 + `pub(crate)` 即可，不改逻辑）：

```
src-tauri/src/
├── settings.rs      # 路径 + 读写 + keyring
├── providers/
│   ├── mod.rs       # provider_kind / url 构造
│   ├── openai.rs / anthropic.rs / gemini.rs
├── chat.rs          # 流式 SSE + 工具调用协议
├── reminders.rs
├── calendar.rs
├── plugins/         # trait + 注册表 + 声明式校验 + wasm 执行
├── rhythm.rs        # 专注 + 空闲 + 作息
├── capture.rs
├── tts.rs
└── updates.rs
```

第二轮再做语义重构（错误类型、异步卫生，见下文）。

## 2. 并发与异步（B2，中高）

### async 命令里同步阻塞

- async `stream_chat`（4622）内直接调用 rusqlite——`memory_db.build_context`（4661-4667）和 `memory::auto_capture_from_chat`（4819-4830），而 `MemoryDb(pub Mutex<Connection>)`（`memory/store.rs:13`）是 std Mutex 包阻塞连接；另有 `read_settings`（4639）与 `append_chat_history`（4801）的文件 I/O。
- 全库**零 `spawn_blocking`**。
- 修复：所有 rusqlite / 文件 I/O 调用包 `tokio::task::spawn_blocking`；`MemoryDb` 可改用 `tokio::sync::Mutex` 或连接池（如 r2d2_sqlite），但最小改动是 spawn_blocking。

### 做得好的部分

- 所有 Mutex 是 std::sync，均短暂持锁即释放，**未发现锁跨 await**；全库 0 个 `lock().unwrap()`。

### 后台线程群（中）

setup 里起 **9+ 个永生线程**（lib.rs:5427-5465）：

| 线程 | 间隔 | 位置 |
| --- | --- | --- |
| 提醒 | 1s | 3353 |
| 日程 | 10s | 3361 |
| 专注 | 1s | 3733 |
| 环境轻推 | 45-300s | 3742 |
| 空闲检测 | 2s | 3836 |
| 前台应用 | 5s | 3872 |
| 作息 | 2s | 3905 |
| typing rollover | 2s | typing_activity.rs:488 |
| 键盘钩子 | 常驻 | typing_activity.rs:469 |

均无退出机制/JoinHandle，进程生命周期常驻。对桌面应用可接受，但建议统一收敛为一个可取消的调度器（见 [06-性能](06-performance-review.md) 的 I/O 收敛方案）。

细节问题：`watch_pet_position` 每个 Moved 事件 spawn 一个防抖线程（2321）；`ActionDrafts`/`ChatRequests` 未确认条目缓慢累积（435）。

## 3. 错误处理（B4，中）

- **141 处 `Result<..., String>`**：错误全部是中文字符串，无 thiserror/anyhow。前端无法程序化区分错误类别（如"未配置 key"vs"网络失败"），也无法国际化。
- 主代码卫生很好：lib.rs 测试模块（5578 行）之前 **0 个 `.unwrap()`**、全库 0 个 `panic!`；仅 3 处启动期 `.expect`：
  - 5353 托盘图标（可接受，图标缺失属于打包错误）；
  - **5429 `init_memory_db`——SQLite 打不开直接崩掉整个应用**，建议降级为无记忆模式运行 + 通知用户；
  - 5575 run。
- 大量 `let _ =` 静默吞错：`persist_settings`（1875-1888）写盘失败用户无任何提示，设置丢失时无从排查。建议至少记日志。

**修复建议**：引入 thiserror 定义错误枚举（`Config`/`Network`/`Storage`/`Plugin`/`Validation` 等 variant），命令边界转成结构化错误（code + message）返回前端；逐步迁移，新代码先用。

## 4. 资源与性能细节

详见 [06-性能](06-performance-review.md)，要点：

- 轮询线程内重复读盘（每 2 秒至少 3 次 settings.json）。
- WASM 每次工具调用重编译 Module。
- `download_update_asset` 把整个安装包读进内存（5328）。
- 更新检查无缓存（5223）。

## 5. Cargo.toml 依赖

- `reqwest` 0.13.4：`default-features=false` + charset/http2/json/native-tls/stream/system-proxy，收敛良好。Windows 下 native-tls 走 schannel 可接受，想精简可换 rustls。
- `wasmtime` + `wasmtime-wasi` 45：默认 feature 全开（cranelift + pooling allocator），对桌面应用偏重；但比砍 feature 更该做的是启用 fuel/epoch（见 [01-安全](01-security-review.md) S4）。
- **`rdev` 0.5.3 与 `screenshots` 0.8.10 均为 2023 年版本**，rdev 已基本无人维护（Wayland 不可用）。键盘钩子建议评估 `GetLastInputInfo`（Windows）替代；截图库可关注社区 fork。
- 未直接声明 `tokio`（tauri 带入），做 spawn_blocking 改造时应显式声明并锁定 features。
- 缺 `thiserror`。

## 6. 测试

详见 [05-测试](05-testing-review.md)。lib.rs 内嵌 `mod tests`（5578-6719，约 1140 行）55 个 `#[test]`，memory 等模块另有 9 个；覆盖位置钳制、URL/请求体构造、SSE delta 解析、工具调用累积、iCalendar 转义等纯函数，质量不低。缺口在 HTTP 层、WASM 执行、keyring/真实文件系统交互。
