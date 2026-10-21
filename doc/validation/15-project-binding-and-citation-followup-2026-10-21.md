# 会话项目与引用后续验收（2026-10-21）

本次完成会话项目绑定、服务端知识库工具范围约束、回复引用位置检查，以及有上限的相邻片段补充。使用说明见 [设计文档](../design/13-conversation-knowledge-and-citations.md)。

## 检索复测

沿用上一轮固定 30 题和原始主证据来源，使用真实 BGE-M3、本机临时数据库与仓库 README / doc 语料，没有修改日常 Piko 数据。

| 指标 | 结果 |
| --- | --- |
| 原始关键词 Top 1 | 19/30 |
| 原始混合检索 Top 1 | 21/30 |
| 原始混合检索 Top 8 | 27/30 |
| 加入相邻片段后的证据覆盖 | 30/30 |
| 原始 Top 8 位置校验 | 240/240 |
| 扩展片段位置校验 | 380/380 |
| 绑定项目后的外项目文档命中 | 0 |

扩展结果最多 14 个片段，仍受 14000 字符上下文预算约束。Q23、Q26、Q30 的原始证据均能进入扩展集合。没有改变原始题目、主来源或证据字符串。上述结果只说明原文可供模型使用，不是生成答案准确率。未绑定项目的对照检索仍能检出另一项目的资料，符合“留空检索全部项目”的行为。

详细结果见 [JSON](15-project-retrieval-results.json)。引用检查的单元测试覆盖缺失引用、错误文件、错误行号、空证据、空白差异和工具页码。会话测试覆盖绑定不可变、数据库重新打开、续跑继承以及项目与通用文档范围。

## 回归

- Rust：339 通过，4 个可选外部服务测试忽略；另行运行真实 BGE-M3 验收通过。
- 前端：301 通过；Agent：67 通过；评分脚本：7 通过。
- Playwright：36 通过，包括 Agent 会话、知识库、Markdown 冲突处理及新增的项目绑定与连续追问用例。
- TypeScript 构建、ESLint、diff 检查通过；构建脚本 25 项通过。
- 发布版 `.app` 构建及内置 Node / SDK / 协议检查通过；已完成本地 ad-hoc 签名与严格签名校验。

Playwright 使用隔离的模拟 IPC；它验证界面和协议边界，不代替真实原生应用与模型交互测试。

## 实际配置模型

读取到实际设置为本机代理 `http://127.0.0.1:8317/v1` 上的 `deepseek-flash2`。代理要求 API 密钥；系统钥匙串读取等待 macOS 授权，尚未取得模型回答。因此本轮没有实际配置模型的准确率、拒答或注入测试结果，不能引用此前 Qwen 小模型成绩代替。

评分脚本已增加 OpenAI-compatible 模式和系统钥匙串读取。它只允许本机端点，不跟随重定向，不使用环境代理，密钥只保留在进程内存，读取有 30 秒超时。完成系统授权后可运行：

```bash
python3 scripts/evaluate-knowledge-answers.py \
  --input /tmp/piko-followup-final.json.qa-input.json \
  --output /tmp/piko-configured-model-answers.json \
  --api openai --endpoint http://127.0.0.1:8317/v1/chat/completions \
  --model deepseek-flash2 --credential-service com.duanluyao.imrobot
```

脚本输入由真实检索验收生成，包含 30 个事实问题、3 个无答案问题，脚本再加入 1 个注入探针。报告仍需逐题人工核实事实，不把程序附加的资料清单计入模型原生引用成绩。
