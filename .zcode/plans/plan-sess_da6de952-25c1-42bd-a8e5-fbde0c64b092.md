# 语音助手模块实施计划

## Context（背景）

Piko 目前具备完整的语音基础设施（SenseVoice 本地 ASR、MiMo 流式 TTS、Passport 硬件语音链路、sherpa-onnx 依赖含未使用的 KWS 绑定），但**桌面端没有自己的麦克风入口**——现有语音输入只能在前端 bubble 窗口活跃时按住录音，无法做到"随时喊一声就能交互"。

本模块目标：新增一个**24 小时常驻的语音助手**——后端持续监听麦克风（纯本地、不上传），检测到唤醒词（默认"你好皮可"）后直接语音对话，可问答也可执行任务。默认关闭，需在设置中开启（涉及常驻麦克风，隐私上必须 opt-in）。

## 方案决策（按推荐默认）

- **唤醒检测**：sherpa-onnx KWS 关键词唤醒（专用 3.3M 小模型 ~25MB，走现有模型下载管线）。CPU 占用极低、非唤醒语音不转写不保存。
- **交互能力**：复用 Passport 硬件语音同款 Agent 执行链（`device_agent::run`），问答 + 任务执行（确认操作弹桌面窗口）。
- **回复播报**：跟随现有 TTS 设置（MiMo 流式优先，回退系统 `say`），同时文字显示在 bubble 窗口。
- **默认唤醒词**："你好皮可"（拼音 tokens：`n i3 h ao3 p i2 k e3`），预设另含"嗨皮可""皮可皮可"，支持自定义（文本 + 拼音 tokens 双字段）。

## A. 后端：新建 `src-tauri/src/voice_assistant/` 模块

新建 5 个文件，在 `lib.rs:14` 区域加 `mod voice_assistant;`：

**`mic.rs` — 麦克风采集**
- `Cargo.toml` 加 `cpal = "0.16"`（已被 rodio 0.21.1 引入依赖树，版本一致不重复编译）。
- `SUPERVISOR.spawn("voice-assistant", ...)` 独立线程：默认输入设备 → f32 单声道 → `sherpa_onnx::resampler` 状态流式重采样到 16kHz → ring buffer 供 KWS。设备热插拔/失联时退避重试重建 stream。

**`kws.rs` — 唤醒词检测**
- 用 crates.io `sherpa-onnx` 1.13.8 安全封装的 `KeywordSpotter` / `KeywordSpotterConfig`（transducer 三件套 + tokens.txt + 生成的 keywords 文件）。
- `generate_keywords(wake_tokens)`：把配置的拼音 tokens 拼成 KWS keywords 行（`tokens @tokens` 格式，须对照 tokens.txt 校验 token 合法性，非法时报错到状态里）。
- 循环喂 16k 音频 → `is_ready`/`decode`/`get_result`；命中后 `reset` stream 并触发会话。命中抑制条件：正在回合中、TTS 播放中/冷却期（防扬声器回声误唤醒）、距上次唤醒 < 8s。

**`session.rs` — 唤醒后回合**（照抄 `device_voice.rs` 的回合骨架）
- 唤醒后继续录指令语音到内存 buffer（trailing RMS 静音 1.5s 结束，上限 12s；v1 用能量端点检测，不引入 VAD 模型）。
- ASR：`SUPERVISOR.blocking("speech-transcription", ...)` → 复用 `speech.rs:267 transcribe_with_sense_voice`（进程级缓存，前提是 SenseVoice 模型已下载）。
- `strip_wake_prefix(transcript, wake_word)` 剥掉唤醒词前缀；空转写则回 idle。
- Agent 回合：复用 `device_agent.rs:201 run()`，`DeviceTurn { device: "desktop-voice", ..., device_confirmation: false }`——确认卡自动走 `open_desktop` 打开会话窗口，无需新代码。消费 `device_voice::Update`：`Stage/Transcript/Response` → 发事件给 UI；`Reply{pcm}` / `Stream{rx}` → rodio 播放（照 `tts_stream.rs:212 playback_ready` 的 16k f32 Sink 模式）；MiMo 流式时走 `tts_stream::synthesize`。
- 全局信号量同一时刻仅一个回合（照 `device_voice.rs:17 VOICE_GATE`）。

**`mod.rs` — 生命周期与事件**
- `pub(crate) fn watch_voice_assistant(app: &AppHandle)`，在 `bootstrap.rs` setup 区（224–243 行的 watcher 群）调用；内部 spawn 麦克风线程 + 读取设置开关。
- 事件：`app.emit_to(["bubble","pet"], "voice-assistant-state", {stage, transcript, reply, message})`，stage ∈ idle/listening/thinking/speaking/error。唤醒时复用托盘"打开面板"路径（`desktop.rs` 的 `open_panel`）唤出 bubble 窗口。
- 每轮循环读设置：开关关闭或 `sensing_paused` 为 true 时静默跳过（不采集解码）。
- 晚订阅补偿：照 `app_updates.rs:24` 的 `LazyLock<Mutex<Option<…>>>` 缓存最后状态。

**`commands.rs` — IPC 命令**
- `get_voice_assistant_status`（含模型就绪、当前 stage、最近转写/回复/错误）。
- `voice_assistant_trigger_listen`：手动触发一次聆听（设置页测试用）。
- 注册进 `bootstrap.rs` 的 `generate_handler!`（248–484 行清单）。

## B. KWS 模型接入下载管线

- `speech.rs:88 speech_model_definitions()` **追加第二项**（保持 sense-voice 在 first）：`id: "kws-wenetspeech"`，URL `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2`（已验证存在），onnx 三件套按 `encoder*/decoder*/joiner*.onnx` glob 匹配；`downloaded` 判定沿用 tokens.txt 检查（归档内含）。
- `SettingsTab.tsx` 现有语音模型下载区块遍历 `get_speech_model_status` 数组，新模型自动出现，仅需补 i18n 文案。

## C. 设置项（照 `update_auto_check_updates` 七步模式）

1. `app_settings.rs`：`voice_assistant_enabled`（默认 false）、`voice_assistant_wake_word`（默认"你好皮可"）、`voice_assistant_wake_tokens`（默认拼音 tokens）+ `default_*()` + `Default` impl。
2. `settings_commands.rs`：`update_voice_assistant_settings` 命令（transaction → 改 → persist → emit settings-updated）。
3. `bootstrap.rs` 注册命令 → `npm run contracts:generate`。

## D. 前端

- `src/types/appTypes.ts` + `src/features/app/appSharedData.ts`：三个新字段的类型与默认值。
- `src/features/panel/tabs/SettingsTab.tsx`：新增 `<details>` 小节"语音唤醒"——开关（含"将常驻使用麦克风"说明）、唤醒词预设下拉 + 自定义（文本/拼音两输入框）、KWS 模型下载状态行、手动试听按钮。
- `src/features/chat/BubbleWindow.tsx`：`listen("voice-assistant-state")` 显示轻量状态胶囊（在听…/思考中/播报中 + 转写文本），样式照 `UpdateBanner.tsx` 的挂载方式。
- `src/locales/{zh-CN,en-US,ja-JP}.json`：`voiceAssistant.*` key 三语补齐（i18n 门禁会查漏）。

## E. 测试与验收

**单测**（`voice_assistant/tests.rs`，纯函数不需要模型，风格照 `device_voice.rs` tests）：keywords 行生成 + 非法 token 校验；`strip_wake_prefix`（含标点/无前缀场景）；回合门/冷却期/唤醒抑制判定；utterance 能量端点状态机。

**验证流程**：
1. `cargo fmt` + `cargo test`（src-tauri 全量）
2. `npm run contracts:generate` → `npm run check`（contracts / i18n / architecture / unused-files 全门禁）
3. `npm run tauri dev` 手动验收：首次开启弹 macOS 麦克风权限（`Info.plist` 描述已就绪）→ 下载 KWS 模型 → 喊"你好皮可"→ bubble 弹出 + 状态胶囊 → 说"帮我创建一个明天九点的提醒"→ 确认窗口弹出 → 语音播报回复。
4. 边界：默认关闭新装用户不受影响；`sensing_paused` 时空闲无 CPU 占用；回合中重复唤醒被抑制；播放回声不误触发。

## 风险与说明

- 唤醒词拼音 tokens 需与模型 tokens.txt 一致，实现时对照归档内示例 `keywords.txt` 校验格式；自定义词拼错 tokens 在生成时报错并显示到状态。
- Agent 回合依赖已配置模型 API Key，未配置时错误信息引导到设置。
- 本期不含：VAD 模型端点检测（用能量法）、多唤醒词并行；音频不出本机、指令转写用后即弃。