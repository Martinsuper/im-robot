# Desktop AI Pet Assistant

跨平台桌面 AI 宠物精灵助手。

## 当前进度

项目已进入 M1 桌面体验：

- `pet`：透明置顶的桌面精灵窗口
- `bubble`：快速对话气泡
- `panel`：助手面板
- 系统托盘：打开助手、显示精灵、退出
- 全局快捷键：`CommandOrControl+Shift+Space`
- 精灵位置：拖动后吸附至屏幕边缘，并在重启后恢复
- 互动活泼度：在面板中选择，并写入本地设置
- 模型服务：支持 Ollama、LM Studio、vLLM 和 OpenAI-Compatible API
- AI 对话：通过 SSE 流式显示模型回复

## 本地运行

```bash
npm install
npm run tauri dev
```

## 文档

- [产品实施基线](docs/desktop-ai-pet-assistant-spec.md)
