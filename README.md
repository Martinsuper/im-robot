# Desktop AI Pet Assistant

跨平台桌面 AI 宠物精灵助手。

## 当前进度

项目已进入 M2 文本对话体验：

- `pet`：透明置顶的桌面精灵窗口
- `bubble`：快速对话气泡
- `panel`：助手面板
- 系统托盘：打开助手、显示精灵、退出
- 全局快捷键：`CommandOrControl+Shift+Space`
- 精灵位置：可自由拖动放置，并在重启后恢复
- 互动活泼度：在面板中选择，并写入本地设置
- 模型服务：支持 Ollama、LM Studio、vLLM 和 OpenAI-Compatible API
- AI 对话：通过 SSE 流式显示模型回复
- 对话控制：支持停止生成、复制结果、最近历史和清除入口
- 文本附件：可拖入单个受控文本文件，预览后选择总结、翻译或解释
- 截图提问：主动框选屏幕区域，预览确认后再发送给模型
- 提醒事项：支持创建、删除、重启恢复和到点系统通知
- 个性化：支持精灵命名、主题色、暂停主动感知和开机启动
- 更新检查：联网查询 GitHub Releases，并跳转到下载页
- 对话窗口：可调整大小，自动记住尺寸，支持背景拖拽移动
- Markdown 渲染：AI 回复支持代码块、加粗、列表、引用等格式

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
