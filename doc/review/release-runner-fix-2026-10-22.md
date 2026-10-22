# v1.2.18 Release CI 失败与修复

## 原因

运行 39743969763 的唯一失败任务为 `verify / frontend`，失败步骤为
`npx playwright install --with-deps chromium`。日志报错：

```text
Cannot install dependencies for ubuntu26.04-x64 with Playwright 1.60.0!
ERROR: Playwright does not support chromium on ubuntu26.04-x64
```

`ubuntu-latest` 镜像漂移至 Playwright 尚不支持的系统版本。
三平台 Rust、安全审计、前端编译和单元测试已通过；浏览器测试未启动，prepare/build/publish 因依赖失败跳过。

## 修复

- 仅将 frontend job 固定为 Ubuntu 24.04，不跳过或弱化任何 CI 门禁。
- 添加 `scripts/ci-workflow.test.mjs`，验证受支持的固定镜像及浏览器安装、测试步骤保留。
- 保留已发布到远程的旧标签，版本文件统一到 v1.2.19，以新标签重新构建。
- 工作流自身的 Linux 执行结果以新 Actions 运行为准，本地 macOS 测试不能替代该验证。
