# 性能审查

> **修复记录（2026-09-29）**：后端 settings 重复读盘已修复（mtime 内存缓存）；PanelWindow 每秒 focus 轮询已删除（保留事件推送）；更新包整体读入内存已改为流式下载。PetSprite WebGL 收敛已完成（2026-10-01）：live2dSnapshot 快照提供者 + variant 机制，BubbleWindow 上下文 2-6+→1；rAF 降频等小项待处理。

跨前后端的性能与资源问题，按"用户可感知程度"排序。

## 1. 前端

### P1. WebGL 上下文乘数（中，最大的前端内存风险）

- 每个 `PetSprite` 实例独立创建 pixi `Application` + 独立加载 Live2D 模型（`src/features/app/appShared.tsx:432-449`、`Live2DCharacterPet.tsx:306`）。
- `BubbleWindow` 同屏可挂 5+ 个 PetSprite（755、219、174、809/843/850 行），每个上下文约占几百 MB 显存上限，且浏览器对 WebGL 上下文总数有限制（~8-16 个），超限后最老的上下文会被强制丢弃，表现为模型突然黑屏/消失。
- **修复建议**：全进程共享一个 pixi `Application` 与模型实例——PetWindow 持有真实模型，气泡/面板等处渲染静态快照（`app.canvas.toDataURL` 或预渲染 sprite），或至少对同模型做实例池。

### 其它前端开销（低，打磨项）

| 问题 | 位置 | 建议 |
| --- | --- | --- |
| fallback 精灵 rAF 恒 60fps 重绘，页面不可见/静止时不暂停 | `LiveCharacterPet.tsx:532-535` | 空闲 N 帧后降频或停帧，`document.visibilitychange` 时暂停 |
| PanelWindow 每秒 `setInterval` 轮询 `get_focus_state`，与 `focus-updated` 事件推送重复 | `PanelWindow.tsx:347-349` | 删掉轮询，只留事件（后端已有推送） |
| 渲染期每条历史记录新建 `Intl.DateTimeFormat` | `PanelWindow.tsx:92-99` | 模块级复用单例 |
| 历史筛选计数每渲染 O(n×6) 全表扫描 | `PanelWindow.tsx:1370-1379` | `useMemo` |
| 每次交互重复 `loadInteractionStats()` 三次（各一次 JSON.parse） | `PetWindow.tsx:140-142` | 一次读取传递 |

## 2. 后端

### P2. 轮询线程群的重复磁盘 I/O（中）

后台常驻线程每 tick 直接重读 JSON 文件（`read_settings` / `read_reminders`），无缓存：

| 线程 | 间隔 | 读盘 | 位置 |
| --- | --- | --- | --- |
| 提醒 | 1s | `read_reminders` | `lib.rs:3266`、`1045` |
| 空闲检测 | 2s | `read_settings` | `lib.rs:3840` |
| 作息 | 2s | `emit_work_rhythm_updated` + `maybe_emit_break_reminder` 各读一次 | `lib.rs:3443`、`3455`、`3905-3909` |

合计**每 2 秒至少 3 次 settings.json 读入 + 解析**，提醒线程每秒一次 reminders 读盘——持续唤醒磁盘，笔记本上影响功耗。

**修复建议（两步）**：
1. settings 进程内缓存：`read_settings` 改为带 mtime 检查的缓存（文件未变直接返回克隆），所有轮询线程无感受益；写盘（`persist_settings`）后主动失效。
2. 中长期：把 9 个独立线程收敛为一个调度器（`crossbeam` 定时轮或 tokio interval），共享一次读取结果分发事件，同时获得可取消性（见 [03-后端](03-backend-review.md) 第 2 节）。

### 其它后端开销

| 问题 | 位置 | 建议 |
| --- | --- | --- |
| async `stream_chat` 中同步 rusqlite/文件 I/O 阻塞 tokio worker | `lib.rs:4661`、`4819` | 包 `spawn_blocking`（详见 [03-后端](03-backend-review.md) B2） |
| WASM 每次工具调用重建 Engine + 从磁盘编译 Module | `lib.rs:1169-1170` | Engine 全局复用，Module 按内容哈希缓存 |
| `download_update_asset` 整包 `bytes()` 读入内存（安装包上百 MB 时内存尖峰） | `lib.rs:5328` | `bytes_stream()` 流式写盘 |
| 更新检查无缓存，每次调用打 GitHub API | `lib.rs:5223` | 结果缓存 1 小时 |
| 前台应用每 5s 轮询 Win32 API | `lib.rs:3872` | 开销小可接受；若做调度器收敛可顺带降频 |
| `watch_pet_position` 每个 Moved 事件 spawn 一个防抖线程 | `lib.rs:2321` | 拖拽高频事件下线程 churn；改为单线程 + `Instant` 状态机 |

## 3. 优先级建议

1. **先做 settings 缓存**：改动小（一个函数）、所有轮询线程自动受益、消除最密集的重复 I/O。
2. **再做 PetSprite 收敛**：这是唯一可能产生用户可见故障（黑屏/崩溃）的前端性能问题。
3. 其余按 [00-总览](00-code-review-overview.md) 阶段四节奏推进。
