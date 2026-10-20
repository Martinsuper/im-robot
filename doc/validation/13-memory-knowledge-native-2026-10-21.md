# 2026-10-21 记忆、知识库和 Markdown 同步交付验收

## 结论

- 已修复原生“打开文件夹”的权限路径：前端调用 `memory_vault_open_directory`，后端只解析已保存的记忆目录，检查持久数据库和目录存在性后调用系统文件管理器。没有扩大前端 opener 权限，也不接受前端传入任意路径。
- 正式 release 应用已重新构建：`src-tauri/target/release/bundle/macos/Piko.app`，版本 1.2.14，Apple Silicon。
- 原生功能使用独立应用 `Piko Memory Test` 验收，应用标识为 `com.duanluyao.imrobot.memoryacceptance20261021`，与用户日常 Piko 数据分离。
- 正式应用运行时、Node/SDK/adapter/protocol 资源检查通过。产物补做本地 ad-hoc 签名后，`codesign --verify --deep --strict` 通过。未申请开发者证书、未做 Apple 公证。

## 原生 UI 与真实 IPC

通过原生 macOS 窗口、真实文件选择器和正式 Tauri 命令执行，未模拟 IPC：

1. 从 Piko 操作菜单打开主面板，进入「记录 → Piko 记住的」。
2. 在隔离记忆库的「用户档案」目录新建一篇无元数据 Markdown 笔记，正文包含合成饮品偏好。
3. 点击立即同步，界面显示读入 1 条；标题和正文出现在真实记忆列表，文件补写 `piko_id`。
4. 点击打开文件夹，Finder 打开隔离应用的真实 `memory-vault`，无 opener 权限错误。
5. 外部修改正文为另一种合成饮品偏好，后台同步后界面显示新内容。
6. 使用系统目录选择器切换到临时测试目录；应用保留旧目录文件，并在新目录写出当前记忆。
7. 使用系统文件选择器导入合成的「发布手册.md」，界面显示 1 个文档、1 个片段。
8. 配置本机 `http://127.0.0.1:11435/v1/embeddings`、模型 `bge-m3`，不启用远程处理、不设置 API Key。真实向量索引显示建立 2 个片段、剩余 0 个。
9. 查询「部署新版本有哪些前置步骤？」时，首位返回发布手册，带真实文件路径和第 1 行来源；正文包含数据库迁移和服务健康检查。
10. 完全退出测试应用，在停机期间再次修改已同步的 Markdown；重新启动后，记忆列表自动显示最新正文，无重复记忆，目录选择和数据库内容均保留。
11. 验收结束关闭隔离应用。没有修改日常 Piko 的模型设置、记忆数据库或 Markdown 目录。

## 真实 Embedding 评测

本机独立 Ollama 服务，版本 0.33.3，BGE-M3 模型摘要：

```text
7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab
```

8 条合成事实、8 个问题，包括中文同义改写和英文查询中文事实。真实请求经过 OpenAI 兼容 `/v1/embeddings`，向量保存进临时 SQLite 后通过生产代码的指纹校验重新读出，并使用生产排序函数评测。

| 检索方式 | Top-1 命中 |
| --- | --- |
| 关键词基线 | 0 / 8 |
| BGE-M3 余弦相似度 | 7 / 8 |
| 生产混合排序 | 7 / 8 |

失败项：问题「线上数据的灾难恢复策略是什么？」将发布迁移事实排在备份事实前。这是小型连通性和召回验收，不代表真实生产准确率；没有为命中全部测试而调整问题、阈值或模型。后续真实资料评测应扩大问题集，并重点覆盖数据库发布、备份、恢复等相近主题。

逐例结果见 [评测 JSON](13-memory-embedding-bge-m3.json)。可复现命令：

```sh
PIKO_EMBEDDING_TEST_ENDPOINT=http://127.0.0.1:11435/v1/embeddings \
PIKO_EMBEDDING_TEST_MODEL=bge-m3 \
cargo test --manifest-path src-tauri/Cargo.toml --lib real_embedding_acceptance -- --ignored --nocapture
```

该测试默认忽略，只有显式提供本机测试服务时运行；使用合成数据，不读取用户记忆或密钥。

## 自动验证

- Rust 库：334 通过、3 忽略；其中新增真实模型测试已单独显式运行并通过，另外 2 项为原有忽略项。
- React/TypeScript：48 个文件、300 项测试通过。
- Agent：67 项测试通过。
- 构建脚本：25 项检查通过。
- 记忆、知识库、Markdown 和桌宠输入相关 Playwright：9 项通过。
- TypeScript/Vite 构建、ESLint、`git diff --check` 通过。
- 新增目录打开回归覆盖：只解析已保存目录，拒绝目录不可用，配置切换后解析新目录；前端不再调用受 ACL 限制的 `openPath`。

构建与产物检查命令：

```sh
npm run tauri -- build --bundles app
npm run inspect:bundle
codesign --force --deep --sign - --timestamp=none src-tauri/target/release/bundle/macos/Piko.app
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/Piko.app
```

签名步骤用于本机可校验的交付产物，不是 Developer ID 签名或公证流程。无需更改已有 npm 构建脚本。
