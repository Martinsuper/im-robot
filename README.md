# Desktop AI Pet Assistant

跨平台桌面 AI 宠物精灵助手。

## 当前进度

P0 基线与 P1 体验打磨已完成，P2 能力扩展已完成专注模式和受控文件写入。当前已实现：

- `pet`：透明置顶的桌面精灵窗口
- `bubble`：快速对话气泡
- `panel`：助手面板
- 系统托盘：打开助手、显示精灵、退出
- 全局快捷键：`CommandOrControl+Shift+Space`
- 精灵位置：可自由拖动放置，并在重启后恢复
- 互动活泼度：在面板中选择，并写入本地设置
- 模型服务：支持 OpenAI Compatible、本地 Ollama / LM Studio / vLLM、Anthropic Claude、Google Gemini、DeepSeek 和通义千问 DashScope
- AI 对话：通过 SSE 流式显示模型回复，并携带会话级最近十轮上下文
- 对话控制：支持停止生成、复制结果、最近历史和清除入口
- 文本附件：可拖入单个受控文本文件，预览后选择总结、翻译或解释
- 截图提问：主动框选屏幕区域，预览确认后再发送给模型
- 提醒事项：支持创建、删除、重启恢复、周期规则和到点系统通知
- 个性化：支持精灵命名、主题色、暂停主动感知和开机启动
- 更新检查：联网查询 GitHub Releases，并跳转到下载页
- 对话窗口：可调整大小，自动记住尺寸，支持背景拖拽移动
- Markdown 渲染：支持 GFM 表格、代码块复制、安全外链和自适应图片
- 语音朗读：使用本地系统 TTS 朗读回复，Web 预览使用 Web Speech API 回退
- 专注模式：支持专注和休息倒计时、暂停、继续、完成通知和今日累计
- 受控文件写入：将回复保存为白名单类型文件，覆盖已有文件前需要确认
- 空闲检测：根据系统距上次输入的时长自动休息和唤醒，不读取具体输入内容

尚未实现的规划能力包括前台应用感知、工具调用、自动更新、首次启动引导、国际化和数据导入导出。详见[后续功能演进路线图](docs/roadmap.md)。

## 本地运行

```bash
npm install
npm run tauri dev
```

## 文档

- [产品实施基线](docs/desktop-ai-pet-assistant-spec.md)
- [P0 功能设计与实施路线](docs/p0-implementation-plan.md)
- [后续功能演进路线图](docs/roadmap.md)
- [当前功能自动化验证报告](docs/current-validation-report.md)

## 素材来源

- 默认像素精灵使用 [OpenPets](https://github.com/alvinunreal/openpets) 的开源素材，遵循 MIT License。
