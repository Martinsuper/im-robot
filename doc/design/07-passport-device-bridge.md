# Piko Passport 设备与语音接入

> 固件已于 2026-10-27 迁移至独立仓库，目录和构建入口见[固件仓库说明](17-firmware-repository.md)。本文中的 `firmware/` 路径为迁移前路径。

## 已实现的边界

电脑端在设置 → 系统与数据 → Piko Passport 中手动开启设备连接。服务监听 IPv4 的 `0.0.0.0:19388`，关闭开关或退出应用会断开设备；应用重启后需重新开启。不自动修改防火墙，不提供公网访问。每次只处理一台 Passport。

Passport 使用官方 ESP32-C3 BSP，8 MB Flash、无 PSRAM。提供宠物、专注、消息、语音四页：

- 宠物页：显示仓库内置 classic Piko 精灵的本地动画；OK 触发与桌面相同的 click 互动，计入现有养成逻辑。
- 专注页：同步电脑现有专注或休息计时；OK 开始 25 分钟专注、暂停或继续；长按 OK 打开结束确认，短按 OK 确认，上下键取消。已有计时不会被开始操作覆盖。
- 消息页：显示连接和按键操作结果。本版尚未转发桌面提醒，也未实现自定义形象素材同步、脱离电脑后的独立专注计时。
- 语音页：按住 OK 录音、松开发送（0.2～12 秒），本地识别、调用聊天模型、系统合成回复，并从设备扬声器播放。短按 OK 或切页取消。支持 GB2312 常用中文字形，长回复每 6 秒翻页。

上下键换页。宠物页长按 OK 重启至配网模式。断线后保留宠物显示，关闭依赖电脑的操作；重新连接后获取完整状态。计时在连线期间按设备单调时钟平滑递减，以每秒电脑快照校准。电脑是计时和宠物养成的唯一权威来源。桌面宠物窗口需要保持存在，隐藏窗口也能处理互动。

## 配对和首次使用

1. 构建桌面应用；开启设备连接，生成 8 位十六进制配对码，有效期 5 分钟。
2. 按 `firmware/passport/README.md` 构建固件。先核对设备原始分区并备份，再经用户确认写入。
3. 首次开机进入配网。连接屏幕显示的 `Piko-Setup-xxxxxx` 热点，密码也显示在屏幕上。
4. 浏览器打开 `http://192.168.4.1`，填写 2.4 GHz Wi-Fi、电脑局域网 IPv4、配对码。
5. 保存后设备重启并连接电脑；电脑配置文件只保存凭证的 SHA-256，设备在自己的 `piko` NVS 命名空间保存 Wi-Fi 和重连凭证。
6. 如果更换电脑、配对码错误/过期或设备保存凭证失败，在电脑解除配对，并在设备宠物页长按 OK 重新配网。

若连接不上，检查电脑 IP 是否变化、无线网络是否隔离客户端、电脑防火墙是否允许该端口、服务是否开启。设备只支持 RFC1918 私网 IPv4，IPv6、mDNS、路由器自动发现暂不支持。

本版使用局域网明文 WebSocket，配对码、重连令牌、语音和文本不受 TLS 加密保护，只适用于可信家庭或开发网络，不应做路由器端口映射。设备不接收模型 API Key、数据库或任意命令执行能力。

## 协议 v1

UTF-8 JSON，单条消息最大 4096 字节。握手与首次认证各限时 3 秒，写超时 2 秒；未认证连接失败后限制重试速度。认证后 30 秒未收到消息则断开，设备每 5 秒发心跳。

```json
{"v":1,"type":"hello","deviceId":"passport-aabbccddeeff","pairingCode":"1234abcd"}
{"v":1,"type":"welcome","token":"<首次配对时返回64位十六进制令牌，重连时为null>"}
{"v":1,"type":"hello","deviceId":"passport-aabbccddeeff","token":"<已保存令牌>"}
{"v":1,"type":"heartbeat","battery":85,"firmware":"piko-0.1.0"}
{"v":1,"type":"event","id":"bootnonce-1","action":"interact"}
{"v":1,"type":"ack","id":"bootnonce-1","ok":true,"error":null}
```

电脑每秒下发完整快照：

```json
{"v":1,"type":"state","petName":"Piko","pet":{"mode":"idle","emotion":"happy","reaction":"greet"},"focus":{"status":"running","kind":"focus","remainingSeconds":1490,"todayMinutes":25}}
```

允许的设备动作仅为 `interact`、`focus_start`、`focus_pause`、`focus_resume`、`focus_stop`。设备至多保留一个待确认事件，每 3 秒重试，15 秒后停止重试并提示用户检查桌面状态，离线时不新增操作。电脑记录当前设备最近 128 个成功事件 ID，重复事件只返回确认。去重窗口在解除配对或应用退出后丢失，不是持久事件队列。

## 语音协议（v1 扩展，固件 0.2.0）

电脑需要下载 SenseVoice 模型并配置聊天模型。录音在电脑本地识别，转写文本交给已配置的模型。语音转写送入桌面同一 Agent，获得人格、记忆、知识库和应用/系统工具。设备 ID 经哈希映射为稳定的独立会话 ID，每轮使用独立请求 ID；沿用该会话的工作目录与知识范围，结果进入现有对话和任务记录。语音链路不再另外写一份简化对话记录。

```json
{"v":1,"type":"voice_start","id":"boot-voice-1","sampleRate":16000,"channels":1,"format":"pcm_s16le"}
```

随后设备发送二进制 PCM 块，每块 1024 字节（服务器允许最高 2048），总长不超过 384000 字节/12 秒，结束发送 `voice_end`。不上传 WAV 文件，电脑为现有识别器包装 WAV 容器。认证前拒绝二进制数据。未开始录音或已取消时到达的尾部音频直接丢弃。

电脑依次发送 `voice_status`（transcribing / thinking / synthesizing）、`voice_transcript`、`voice_reply`，各条都携带同一个 `id`。成功合成后发送：

```json
{"v":1,"type":"voice_audio","id":"boot-voice-1","sampleRate":16000,"channels":1,"format":"pcm_s16le","bytes":64000}
```

电脑最多先发四个 2048 字节二进制块。设备将一块写入 I2S 后返回 `voice_credit`，`count` 为已消费块数（1～4），电脑据此继续发送。设备录音队列为 3 × 1024 字节、播放队列为 4 × 2048 字节，未使用整段音频缓冲。

电脑发完 PCM 后发送 `voice_audio_end`；设备校验总字节数、完成播放，再发送 `voice_played`。电脑最后发送 `voice_status: done`。音频合成失败时发送 `voice_status: text_only` 并保留文字回复；其他错误发送 `voice_error`。模型服务原始错误不回传设备，防止 URL 或错误详情带出 API 凭证。

`voice_cancel`、断开连接或关闭服务都会丢弃当前音频、取消模型/TTS 工作。已开始的本地 ASR 计算会完成后停止后续处理，不会强杀识别线程。每台电脑同时只允许一轮语音处理；录音最长 12 秒、上传窗口 15 秒、处理最多 300 秒（包括等待确认）、回复音频最多 40 秒、整轮最多 420 秒。心跳与原有状态快照在语音期间继续工作。

macOS 使用本地 `say` 生成 16kHz PCM WAV（中文用 Tingting）；Windows 使用 System.Speech 后重采样；Linux 使用 espeak-ng 后重采样。系统 TTS 不可用时显示文字，不自动安装系统音色。设备初始音量为 55%，尚未提供独立音量设置。

## 工具执行与确认（固件 0.3.0）

识别文字通过 `agent::start_passport_agent` 调用桌面原有任务执行器。提醒、备忘、日历、知识检索、文件和命令沿用原工具与授权策略；新增 `piko.focus` 插件（查询、开始专注/休息、暂停、继续、结束），所有计时修改也需要确认，且开始操作不会覆盖已有计时。

设备握手声明 `capabilities: ["voice-confirm-v1"]`。没有该能力的旧设备仍能发起语音任务，确认统一转到桌面。

```json
{"v":1,"type":"voice_confirmation","id":"boot-voice-1","confirmationId":"<随机128位一次性标识>","message":"<完整摘要和参数>","desktopOnly":false}
{"v":1,"type":"voice_confirm","id":"boot-voice-1","confirmationId":"<同一个标识>"}
{"v":1,"type":"voice_reject","id":"boot-voice-1","confirmationId":"<同一个标识>"}
```

仅内置提醒、日程、备忘和专注操作可在设备确认，预览必须包含完整参数、不超过600个字符/2200字节，且全部字形在已编译字体覆盖内；否则自动转到桌面。文件、命令和工作目录始终沿用电脑端流程，现有命令自动批准设置不被语音链路改变。需要桌面处理时，自动打开对应的“Passport 语音任务”窗口，恢复同一请求的确认卡或目录选择。

确认标识与当前语音轮次及当前原生草稿绑定，过期120秒、重复、错轮次、旧标识或 `desktopOnly` 确认不能授权操作。设备还要求卡片已显示，并在该卡片显示后有一次新按下事件；录音释放的延迟单击和旧卡片按键不能触发执行。确认消费后设备显示“正在处理”，只有 Agent 报告终态并返回实际结果后才生成最终播报。

电脑端确认、拒绝、修改任务要求或取消也会使设备旧卡片失效。目录/文件授权不在设备端另建旁路。取消、断线或处理超时会取消对应 Agent，请在任务记录核对已完成步骤；不会自动重放写操作。不同 Agent 事件按请求 ID 过滤，队列溢出时停止而非丢失关键确认事件。

## 代码位置

- `src-tauri/src/device_agent.rs`：语音到桌面 Agent 的事件桥、原生确认、桌面交接、取消与稳定会话。
- `src-tauri/src/plugins/focus.rs`：共用专注计时的工具定义和执行适配。
- `src-tauri/src/device_voice.rs`：有限录音、识别与回复流水线、音频发送窗口、取消和语音历史。
- `src-tauri/src/devices.rs`：独立线程监听、认证、状态快照、动作白名单、事件去重。
- `src/features/panel/DeviceSettings.tsx`：开启、配对、连接/电量信息、解除配对。
- `src/features/pet/PetWindow.tsx`：复用真实互动入口，发布可显示的宠物状态。
- `firmware/passport/`：独立 ESP-IDF 项目，官方 BSP 固定到具体 commit，使用本地 RGB565 动画。

## 真机验收

构建通过不等于设备验收。上板需验证：显示方向/色彩/动画、三个按键、热点配网、配对成功及错误码、凭证重启保存、桌面与设备双向专注控制、重复事件不重复互动、断网/电脑休眠后重连、电量读取与持续运行时最低堆内存。还需验证录音灵敏度、扬声器音量、连续语音、网络抖动、按键释放与取消，以及中文字符的真实显示。
