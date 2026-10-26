# MiMo 语音输出接入

Piko 的电脑朗读与 Passport 语音回复共用一套语音输出设置。输入识别仍由本地 SenseVoice 完成。设备继续接收 16kHz 单声道 PCM16，无需刷固件。

## 使用

1. 打开桌面端「设置 → AI 与对话 → 语音输出与音色」。
2. 语音服务选择「小米 MiMo 云端语音」，填写 MiMo 控制台生成的 API Key。
3. 选择冰糖、茉莉（中文女声）或苏打、白桦（中文男声），可填写不超过500字的语气描述。
4. 点击「保存并试听」。之后电脑朗读和设备语音回复均使用所选音色。回复文字会发送至 MiMo，录音识别保持本地。
5. 若要恢复离线播报，选择「系统语音（离线）」并保存。删除 MiMo 密钥会同时恢复系统音色。

API Key 通过系统凭据库存储，条目为独立的 `mimo-tts-api-key`，不会覆盖聊天模型密钥。前端只获知是否配置，不读回密钥；留空保留现有密钥。非秘密配置保存在应用配置目录的 `speech-output.json`。

## 协议与限制

- 固定官方端点：`POST https://api.xiaomimimo.com/v1/chat/completions`，模型 `mimo-v2.5-tts`。
- 语气指令放 `user` 消息，播报内容放 `assistant` 消息；请求 WAV，读取 `choices[0].message.audio.data` 的 Base64 音频，解码后转换为设备格式。
- 第一版使用非流式请求：整段合成后播放，没有宣称边生成边播放。单次音频最多40秒，响应最多4MiB；连接10秒、总请求60秒超时。设备取消任务或电脑停止试听会取消等待中的请求，取消后不会启动迟到音频。
- 不自动跟随 HTTP 重定向，不将密钥发至其它端点；认证、限流、额度及其它错误使用中文提示，不回显上游响应正文或密钥。不静默改回用户不满意的系统声音；合成失败保留设备文字回复。
- 本次未配置用户 MiMo API Key，真实 API 权限、云端音色与设备端完整播放需填写密钥后实测。
- 当前官网标注限时免费，后续收费和额度以官方控制台为准。

官方接口依据：https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5
官方定价：https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go

## 流式播放更新

MiMo电脑朗读现使用流式PCM持续播放；Passport在0.5.0及声明 `voice-stream-v1` 能力后同样边生成边播放，老固件保留原有兼容路径。流式解码、跨块重采样、有限缓冲及完整性检查见 `doc/validation/2026-10-24-mimo-stream.md`。
