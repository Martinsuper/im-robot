# 工程体系审查

> **修复记录（2026-09-29）**：E1 已修复（补装 `typescript-eslint`、16 个 error 清零、package.json 增加 `lint` script、CI 增加 lint 步骤）；E2 已修复（`ci.yml` 增加 push main 触发）；E3 部分修复（`.gitignore` 增加 `.tauri/`、新增 `.gitattributes` 统一 LF；playwright 浏览器探测待补 Windows 路径）。release.yml 防误删与版本号校验待处理。

覆盖 lint、CI、发布流程与仓库卫生。

## 1. ESLint 完全失效（E1，高）

- 现象：`npx eslint src` 报 `ERR_MODULE_NOT_FOUND: Cannot find package 'typescript-eslint'`。
- 根因：`eslint.config.js:2` 引用了 `typescript-eslint` 聚合包，但 `package.json` devDependencies 只有 `@typescript-eslint/eslint-plugin` 和 `@typescript-eslint/parser`，没有 `typescript-eslint`。
- 后果被放大的原因：**CI 里没有 lint 步骤**（`.github/workflows/ci.yml` 前端 job 只跑 `npm test` / `npm run build` / e2e），所以配置损坏一直没暴露。

修复建议：

```bash
npm i -D typescript-eslint
```

然后在 `ci.yml` 前端 job 的 `npm test` 之前加 `- run: npm run lint`（package.json 补 `"lint": "eslint src"`）。

## 2. CI 触发与覆盖（E2，中）

- `ci.yml` 只在 `pull_request` 触发——**直接 push 到 main 不做任何检查**。当前仓库正是直接 push main 的工作流（见 git log），意味着大部分提交实际未经 CI 验证。
- 建议：`on: { push: { branches: [main] }, pull_request: ... }`。
- Rust 侧 CI 覆盖良好：`cargo fmt --check`、`clippy --all-targets --all-features -- -D warnings`、`cargo test`。
- 前端 CI 缺 `eslint`（见上）与 `tsc`（`npm run build` 内含 `tsc`，已覆盖）。

## 3. 发布流程（release.yml）

- 现状可用：tag 触发三平台矩阵构建，`prepare` job 删除自动创建的 release 后创建正式 release，build job 用 `releaseId` 上传资产，规避了此前的创建竞态（该问题在近期 6 个 `fix(ci)` 提交中反复折腾，当前方案已稳定）。
- 遗留风险点：
  1. `prepare` 中删除已有 release 的逻辑（`gh release view "$TAG"` → delete）在重跑 workflow 时会**删掉已发布的正式版**。建议改为：存在同名 release 时报错退出，由人工决定删除。
  2. 版本号一致性靠人工维护三处（package.json、tauri.conf.json、Cargo.toml），近期提交已出现过 Cargo.lock 落后于 package.json 的情况（本次工作区 diff 即在补 1.2.1→1.2.7）。建议加一步 CI 校验或用脚本一次性更新三处。
  3. 下载资产无校验和发布（对应 [01-安全](01-security-review.md) S3），建议构建完成后生成 SHA-256SUMS 一并上传。

## 4. 仓库卫生（E3，低）

| 问题 | 说明 | 修复 |
| --- | --- | --- |
| `.tauri/` 未忽略 | 根目录与 `src-tauri/.tauri/` 均为 untracked，`git status` 长期有噪音 | `.gitignore` 加 `.tauri/` |
| CRLF 警告 | diff 时反复出现 `LF will be replaced by CRLF` 警告 | 加 `.gitattributes`：`* text=auto eol=lf`（或按团队习惯统一） |
| e2e 浏览器探测只覆盖 macOS | `playwright.config.ts` 的 `detectChromeExecutable` 候选路径只有两个 macOS 路径；Windows 本地需手动设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 加入 Windows/常见 Chrome 路径，或本地统一用 `npx playwright install chromium` |
| 版本号散布 | 同上第 3 点 | 发布脚本统一改版本 |

## 5. 依赖版本

- 前端依赖整体较新（React 19、Vite 7、ESLint 9、Playwright 1.60），无突出问题。
- Rust 侧 `rdev` 0.5.3 / `screenshots` 0.8.10 陈旧且近乎失修，见 [03-后端](03-backend-review.md) 第 5 节。
- 建议：开启 Dependabot（`.github/dependabot.yml`）分别管理 npm 与 cargo 更新。

## 6. 修复清单（按顺序）

1. 补装 `typescript-eslint`，package.json 加 `lint` script（E1）。
2. `ci.yml`：加 lint 步骤 + push main 触发（E1/E2）。
3. `.gitignore` 加 `.tauri/`；加 `.gitattributes` 统一换行（E3）。
4. `release.yml`：存在同名 release 时中止而非删除（防误删正式版）；增加三处版本号一致性校验。
5. 开启 Dependabot。
