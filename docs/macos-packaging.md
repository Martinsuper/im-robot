# macOS ad-hoc 签名与打包

运行 `npm run build:app`（调试包使用 `npm run build:app:debug`）。GitHub Release 使用相同的 `scripts/package-macos.mjs`。

流程：Tauri 只生成 `.app` → 枚举所有 Mach-O 文件（包括资源目录中的 Node 原生模块，跳过符号链接和静态库）→ 二进制签名 → 嵌套 bundle 从内到外签名 → 最外层应用签名 → 严格验证 → 创建 DMG 和保留资源、权限、符号链接的 ZIP → 解压 ZIP 再验证。任一步失败即停止发布。

签名使用 `codesign --force --sign - --timestamp=none`，无需开发者账号。所有二进制修改、资源复制和 Info.plist 修改必须在签名前完成。不要对已签名的包再执行 strip、install_name_tool 等操作。

本地输出在 `artifacts/release/`，CI 输出在 `src-tauri/target/release/bundle/`。发布包含 DMG、APP ZIP 和 SHA-256 校验文件。DMG 直接使用 hdiutil 创建，无需 Finder 或 AppleScript；ZIP 使用 `ditto --sequesterRsrc --keepParent` 创建。

## 下载验收

在另一台 Mac 或干净的测试账户中，通过浏览器下载 DMG，将 Piko 拖入 Applications 后打开。保留真实下载附带的隔离属性，确认提示和系统设置 → 隐私与安全性 → 仍要打开的实际行为。分别检查 Apple Silicon 和 Intel；测试首次授权、重启与升级后的系统权限。

也可在专用测试副本上模拟隔离标记（不要给正式构建产物加标记）：

```sh
ditto /Applications/Piko.app /tmp/Piko-quarantine-test.app
xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");PikoPackagingTest;" /tmp/Piko-quarantine-test.app
open /tmp/Piko-quarantine-test.app
```

完整性检查：

```sh
codesign --verify --deep --strict --verbose=2 /Applications/Piko.app
codesign -dv --verbose=4 /Applications/Piko.app
spctl --assess --type execute --verbose=4 /Applications/Piko.app
```

ad-hoc 签名没有开发者身份，也没有 Apple 公证，因此 `spctl` 拒绝并不等于签名损坏，不能作为本方案的构建成功条件。不同 macOS 版本的首次打开行为需要实机确认；本方案不保证 Gatekeeper 放行，也不通过移除隔离属性或关闭系统安全检查来验收。升级后可能需要重新授予系统权限。
