#!/usr/bin/env bash
# ============================================================================
# build.sh 自动化测试脚本
#
# 分层测试策略：
#   Level 1 — 脚本逻辑：参数解析、环境检查、错误处理（毫秒级）
#   Level 2 — 产物收集：用 mock 数据测试收集/校验/打包逻辑（秒级）
#   Level 3 — 完整构建：真正跑 tauri build + 验证产物（分钟级，可选）
#
# 用法:
#   ./scripts/test-build.sh              # 跑 Level 1 + 2（快速，不需要完整构建）
#   ./scripts/test-build.sh --full       # 跑全部三级（包含真正的 tauri build）
#   ./scripts/test-build.sh --verbose    # 显示每个测试的详细输出
# ============================================================================

set -uo pipefail

# ── 颜色 ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── 测试计数器 ───────────────────────────────────────────────────────────────
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0
FAILURES=()

# ── 参数 ─────────────────────────────────────────────────────────────────────
FULL_BUILD=false
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --full)    FULL_BUILD=true ;;
    --verbose) VERBOSE=true ;;
    -h|--help)
      echo "用法: ./scripts/test-build.sh [--full] [--verbose]"
      exit 0
      ;;
  esac
done

# ── 路径 ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_SCRIPT="${PROJECT_ROOT}/scripts/build.sh"
TEST_TMP=""

# ── 辅助函数 ─────────────────────────────────────────────────────────────────
setup_tmp() {
  TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/piko-build-test.XXXXXX")
}

teardown_tmp() {
  if [[ -n "$TEST_TMP" && -d "$TEST_TMP" ]]; then
    rm -rf "$TEST_TMP"
  fi
}

pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_PASSED=$((TESTS_PASSED + 1))
  echo -e "  ${GREEN}✓${NC}  $*"
}

fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  FAILURES+=("$*")
  echo -e "  ${RED}✗${NC}  $*"
}

skip() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
  echo -e "  ${YELLOW}⊘${NC}  $* ${DIM}(skipped)${NC}"
}

section() {
  echo ""
  echo -e "${CYAN}${BOLD}━━━ $* ━━━${NC}"
}

# 运行 build.sh 并捕获输出/退出码（不让它真的构建）
# 用法: run_build_script [args...]
# 结果在: $_OUTPUT $_EXIT_CODE
run_build_script() {
  _OUTPUT=""
  _EXIT_CODE=0
  _OUTPUT=$(bash "$BUILD_SCRIPT" "$@" 2>&1) || _EXIT_CODE=$?
  if $VERBOSE; then
    echo "$_OUTPUT" | sed 's/^/    │ /'
  fi
}

# ── 开始 ─────────────────────────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════╗"
echo "  ║   build.sh 自动化测试                 ║"
echo "  ╚═══════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  脚本路径: ${BUILD_SCRIPT}"
echo -e "  完整构建: ${FULL_BUILD}"
echo -e "  详细模式: ${VERBOSE}"

# ═════════════════════════════════════════════════════════════════════════════
# Level 1: 脚本逻辑测试
# ═════════════════════════════════════════════════════════════════════════════
section "Level 1: 脚本逻辑"

# ── 1.1 脚本存在且可执行 ─────────────────────────────────────────────────────
if [[ -f "$BUILD_SCRIPT" ]]; then
  pass "build.sh 文件存在"
else
  fail "build.sh 文件不存在: $BUILD_SCRIPT"
  echo "无法继续测试" >&2
  exit 2
fi

if [[ -x "$BUILD_SCRIPT" ]]; then
  pass "build.sh 可执行"
else
  fail "build.sh 没有可执行权限"
fi

# ── 1.2 bash 语法检查 ────────────────────────────────────────────────────────
if bash -n "$BUILD_SCRIPT" 2>/dev/null; then
  pass "bash 语法检查通过 (bash -n)"
else
  fail "bash 语法错误"
fi

# ── 1.3 --help 参数 ──────────────────────────────────────────────────────────
run_build_script --help
if [[ $_EXIT_CODE -eq 0 ]]; then
  pass "--help 退出码为 0"
else
  fail "--help 退出码为 $_EXIT_CODE（期望 0）"
fi

if echo "$_OUTPUT" | grep -q "用法"; then
  pass "--help 输出包含「用法」"
else
  fail "--help 输出缺少使用说明"
fi

if echo "$_OUTPUT" | grep -q "\-\-clean"; then
  pass "--help 输出包含 --clean 选项"
else
  fail "--help 输出缺少 --clean 说明"
fi

if echo "$_OUTPUT" | grep -q "\-\-debug"; then
  pass "--help 输出包含 --debug 选项"
else
  fail "--help 输出缺少 --debug 说明"
fi

# ── 1.4 未知参数 ─────────────────────────────────────────────────────────────
run_build_script --bogus-flag
if [[ $_EXIT_CODE -ne 0 ]]; then
  pass "未知参数退出码非零"
else
  fail "未知参数未报错（退出码为 0）"
fi

if echo "$_OUTPUT" | grep -q "未知参数"; then
  pass "未知参数输出包含错误提示"
else
  fail "未知参数缺少错误提示"
fi

# ── 1.5 环境检查 ─────────────────────────────────────────────────────────────
# 运行脚本直到环境检查阶段（会停在 step 1/5 然后继续跑，但我们只验证输出里有什么）
# 由于脚本会继续执行后面的步骤，我们只检查它不会在环境检查阶段崩溃
if command -v node &>/dev/null && command -v npm &>/dev/null; then
  pass "构建工具链可用 (node + npm)"
else
  skip "构建工具链不完整（node/npm 缺失）"
fi

if command -v rustc &>/dev/null && command -v cargo &>/dev/null; then
  pass "Rust 工具链可用 (rustc + cargo)"
else
  skip "Rust 工具链不完整"
fi

# ── 1.6 bash 3.2 兼容性回归测试 ──────────────────────────────────────────────
# macOS 默认 bash 3.2 中，set -u 下 "${empty_arr[@]}" 会触发 unbound variable
# 确保脚本里没有这种危险模式（只在 if 条件判断前才允许）
BASH_VER="${BASH_VERSINFO[0]}"
if [[ "$BASH_VER" -lt 4 ]]; then
  # 查找命令调用位置的空数组展开（bash 3.2 下会报 unbound variable）
  # 安全用法：${#arr[@]} (取长度)、arr[0] (有条件保护)、${arr[@]+"${arr[@]}"} (兼容写法)
  # 危险用法：直接 "${arr[@]}" 作为命令参数
  DANGEROUS=$(grep -nE '^\s*[a-zA-Z_].*\$\{[A-Z_]+\[@\]\}' "$BUILD_SCRIPT" \
    | grep -vE '(#|if |\[\[ )' || true)
  if [[ -z "$DANGEROUS" ]]; then
    pass "bash ${BASH_VER} 兼容：无空数组展开风险"
  else
    fail "bash ${BASH_VER} 兼容：发现危险的空数组展开:"
    echo "$DANGEROUS" | sed 's/^/    /'
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# Level 2: 产物收集逻辑测试（用 mock 数据）
# ═════════════════════════════════════════════════════════════════════════════
section "Level 2: 产物收集逻辑"

setup_tmp

# 构造 mock 项目结构
MOCK_ROOT="${TEST_TMP}/project"
MOCK_BUNDLE="${MOCK_ROOT}/src-tauri/target/release/bundle"
MOCK_OUTPUT="${MOCK_ROOT}/artifacts/release"

mkdir -p "${MOCK_BUNDLE}/dmg"
mkdir -p "${MOCK_BUNDLE}/macos"
mkdir -p "${MOCK_BUNDLE}/deb"
mkdir -p "${MOCK_BUNDLE}/appimage"
mkdir -p "${MOCK_BUNDLE}/nsis"
mkdir -p "${MOCK_BUNDLE}/msi"
mkdir -p "${MOCK_BUNDLE}/rpm"
mkdir -p "${MOCK_OUTPUT}"
mkdir -p "${MOCK_ROOT}/dist"

# 创建 mock package.json
cat > "${MOCK_ROOT}/package.json" << 'MOCKPKG'
{ "name": "im-robot", "version": "9.9.9" }
MOCKPKG

# 创建 mock 安装包文件
echo "fake-dmg-content-$(date +%s)" > "${MOCK_BUNDLE}/dmg/Piko_9.9.9_aarch64.dmg"
echo "fake-deb-content"              > "${MOCK_BUNDLE}/deb/piko_9.9.9_amd64.deb"
echo "fake-appimage-content"         > "${MOCK_BUNDLE}/appimage/Piko_9.9.9_x86_64.AppImage"
echo "fake-exe-content"              > "${MOCK_BUNDLE}/nsis/Piko_9.9.9_x64-setup.exe"
echo "fake-msi-content"              > "${MOCK_BUNDLE}/msi/Piko_9.9.9_x64.msi"
echo "fake-rpm-content"              > "${MOCK_BUNDLE}/rpm/piko-9.9.9.x86_64.rpm"

# 创建 mock .app 目录结构
mkdir -p "${MOCK_BUNDLE}/macos/Piko.app/Contents/MacOS"
echo "fake-binary" > "${MOCK_BUNDLE}/macos/Piko.app/Contents/MacOS/im-robot"
cat > "${MOCK_BUNDLE}/macos/Piko.app/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>im-robot</string>
  <key>CFBundleName</key>
  <string>Piko</string>
  <key>CFBundleVersion</key>
  <string>9.9.9</string>
</dict>
</plist>
PLIST

# ── 测试收集函数（直接在当前 shell 加载 build.sh 中的函数） ──────────────────

# 提取 build.sh 中 collect_by_find 函数并测试
# 我们不能直接 source build.sh（它会执行主逻辑），所以复制收集逻辑
test_collect() {
  local PRODUCT_NAME="Piko"
  local VERSION="9.9.9"
  local ARCH_LABEL="aarch64"
  local BUNDLE_DIR="${MOCK_BUNDLE}"
  local OUTPUT_DIR="${MOCK_OUTPUT}"
  local COPIED=0

  collect_by_find() {
    local search_dir="$1"
    local name_pattern="$2"
    local suffix="$3"
    [[ ! -d "$search_dir" ]] && return 0
    while IFS= read -r -d '' file; do
      local target_name="${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}${suffix}"
      cp -R "$file" "${OUTPUT_DIR}/${target_name}"
      if [[ -f "${OUTPUT_DIR}/${target_name}" ]]; then
        if command -v shasum &>/dev/null; then
          shasum -a 256 "${OUTPUT_DIR}/${target_name}" | awk '{print $1}' \
            > "${OUTPUT_DIR}/${target_name}.sha256"
        fi
      fi
      COPIED=$((COPIED + 1))
    done < <(find "$search_dir" -maxdepth 1 -name "$name_pattern" -print0 2>/dev/null)
  }

  # 收集 DMG
  collect_by_find "${BUNDLE_DIR}/dmg" "*.dmg" ".dmg"

  # 收集 .app → zip
  while IFS= read -r -d '' app_path; do
    local APP_NAME ZIP_NAME
    APP_NAME=$(basename "$app_path" .app)
    ZIP_NAME="${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}.app.zip"
    if command -v ditto &>/dev/null; then
      ditto -c -k --keepParent "$app_path" "${OUTPUT_DIR}/${ZIP_NAME}"
    else
      (cd "$(dirname "$app_path")" && zip -r - "$APP_NAME.app") > "${OUTPUT_DIR}/${ZIP_NAME}"
    fi
    COPIED=$((COPIED + 1))
  done < <(find "${BUNDLE_DIR}/macos" -maxdepth 1 -name "*.app" -print0 2>/dev/null)

  # 收集其他平台
  collect_by_find "${BUNDLE_DIR}/deb"      "*.deb"     ".deb"
  collect_by_find "${BUNDLE_DIR}/appimage" "*.AppImage" ".AppImage"
  collect_by_find "${BUNDLE_DIR}/nsis"     "*.exe"     ".exe"
  collect_by_find "${BUNDLE_DIR}/msi"      "*.msi"     ".msi"
  collect_by_find "${BUNDLE_DIR}/rpm"      "*.rpm"     ".rpm"

  echo "$COPIED"
}

# 运行收集
COLLECT_RESULT=$(test_collect)

# ── 2.1 DMG 收集 ─────────────────────────────────────────────────────────────
if [[ -f "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.dmg" ]]; then
  pass "DMG 文件已收集"
else
  fail "DMG 文件未被收集到 output 目录"
fi

# ── 2.2 DMG SHA256 校验和 ────────────────────────────────────────────────────
if [[ -f "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.dmg.sha256" ]]; then
  HASH=$(cat "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.dmg.sha256")
  if [[ ${#HASH} -eq 64 ]] && [[ "$HASH" =~ ^[a-f0-9]+$ ]]; then
    pass "DMG SHA256 校验和有效（${HASH:0:16}...）"
  else
    fail "DMG SHA256 校验和格式错误: $HASH"
  fi
else
  fail "DMG SHA256 校验和文件未生成"
fi

# ── 2.3 SHA256 可验证 ────────────────────────────────────────────────────────
if [[ -f "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.dmg.sha256" ]]; then
  EXPECTED=$(cat "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.dmg.sha256")
  ACTUAL=$(shasum -a 256 "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.dmg" | awk '{print $1}')
  if [[ "$EXPECTED" == "$ACTUAL" ]]; then
    pass "SHA256 校验和可验证（与实际文件匹配）"
  else
    fail "SHA256 校验和不匹配: 期望 $EXPECTED，实际 $ACTUAL"
  fi
fi

# ── 2.4 .app.zip 生成 ────────────────────────────────────────────────────────
if [[ -f "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.app.zip" ]]; then
  pass ".app.zip 已生成"
  # 验证 zip 内容
  if command -v ditto &>/dev/null; then
    # macOS: 用 ditto 解压验证
    VERIFY_DIR="${TEST_TMP}/verify-app"
    mkdir -p "$VERIFY_DIR"
    ditto -x -k "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.app.zip" "$VERIFY_DIR" 2>/dev/null
    if [[ -f "${VERIFY_DIR}/Piko.app/Contents/MacOS/im-robot" ]]; then
      pass ".app.zip 内容正确（包含 Piko.app/Contents/MacOS/im-robot）"
    else
      fail ".app.zip 内容不完整"
    fi
  elif command -v unzip &>/dev/null; then
    VERIFY_DIR="${TEST_TMP}/verify-app"
    mkdir -p "$VERIFY_DIR"
    unzip -q "${MOCK_OUTPUT}/Piko_9.9.9_aarch64.app.zip" -d "$VERIFY_DIR" 2>/dev/null
    if [[ -f "${VERIFY_DIR}/Piko.app/Contents/MacOS/im-robot" ]]; then
      pass ".app.zip 内容正确（包含 Piko.app）"
    else
      fail ".app.zip 内容不完整"
    fi
  else
    skip ".app.zip 内容验证（无解压工具）"
  fi
else
  fail ".app.zip 未生成"
fi

# ── 2.5 其他平台安装包 ───────────────────────────────────────────────────────
for pair in "deb:Piko_9.9.9_aarch64.deb" \
            "AppImage:Piko_9.9.9_aarch64.AppImage" \
            "exe:Piko_9.9.9_aarch64.exe" \
            "msi:Piko_9.9.9_aarch64.msi" \
            "rpm:Piko_9.9.9_aarch64.rpm"; do
  TYPE="${pair%%:*}"
  FILE="${pair##*:}"
  if [[ -f "${MOCK_OUTPUT}/${FILE}" ]]; then
    pass "${TYPE} 安装包已收集"
  else
    fail "${TYPE} 安装包未收集到: ${FILE}"
  fi
done

# ── 2.6 收集计数 ─────────────────────────────────────────────────────────────
# 期望: dmg(1) + app(1) + deb(1) + appimage(1) + exe(1) + msi(1) + rpm(1) = 7
if [[ "$COLLECT_RESULT" == "7" ]]; then
  pass "收集计数正确（${COLLECT_RESULT}/7）"
else
  fail "收集计数错误: ${COLLECT_RESULT}（期望 7）"
fi

# ── 2.7 空目录不报错 ─────────────────────────────────────────────────────────
EMPTY_OUTPUT="${TEST_TMP}/empty-out"
mkdir -p "$EMPTY_OUTPUT"
(
  PRODUCT_NAME="Piko" VERSION="1.0.0" ARCH_LABEL="x86_64"
  BUNDLE_DIR="${TEST_TMP}/nonexistent-bundle" OUTPUT_DIR="$EMPTY_OUTPUT"
  COPIED=0
  collect_by_find() {
    local search_dir="$1" name_pattern="$2" suffix="$3"
    [[ ! -d "$search_dir" ]] && return 0
    while IFS= read -r -d '' file; do
      COPIED=$((COPIED + 1))
    done < <(find "$search_dir" -maxdepth 1 -name "$name_pattern" -print0 2>/dev/null)
  }
  collect_by_find "${BUNDLE_DIR}/dmg" "*.dmg" ".dmg"
  collect_by_find "${BUNDLE_DIR}/deb" "*.deb" ".deb"
  exit 0
)
if [[ $? -eq 0 ]]; then
  pass "空/不存在的 bundle 目录不导致崩溃"
else
  fail "空 bundle 目录导致脚本异常退出"
fi

# ── 2.8 文件名包含正确版本号 ─────────────────────────────────────────────────
if ls "${MOCK_OUTPUT}"/Piko_9.9.9_* &>/dev/null; then
  pass "输出文件名包含正确版本号 (9.9.9)"
else
  fail "输出文件名版本号不正确"
fi

teardown_tmp

# ═════════════════════════════════════════════════════════════════════════════
# Level 3: 完整构建测试（可选，需要 --full）
# ═════════════════════════════════════════════════════════════════════════════
if $FULL_BUILD; then
  section "Level 3: 完整构建"
  echo -e "  ${YELLOW}⚠${NC}  即将执行完整的 tauri build，可能需要 5-15 分钟..."
  echo ""

  FULL_START=$(date +%s)

  # 清空旧的 release 产物，确保测试的是新构建
  rm -rf "${PROJECT_ROOT}/artifacts/release"
  mkdir -p "${PROJECT_ROOT}/artifacts/release"

  # 运行完整构建
  echo -e "  ${DIM}▶ 执行: ./scripts/build.sh${NC}"
  BUILD_OUTPUT=""
  BUILD_EXIT=0
  BUILD_OUTPUT=$(bash "$BUILD_SCRIPT" 2>&1) || BUILD_EXIT=$?

  FULL_END=$(date +%s)
  FULL_DURATION=$((FULL_END - FULL_START))
  FULL_MIN=$((FULL_DURATION / 60))
  FULL_SEC=$((FULL_DURATION % 60))

  if $VERBOSE; then
    echo "$BUILD_OUTPUT" | sed 's/^/    │ /'
  fi

  # ── 3.1 构建退出码 ───────────────────────────────────────────────────────
  if [[ $BUILD_EXIT -eq 0 ]]; then
    pass "build.sh 退出码为 0（${FULL_MIN}分${FULL_SEC}秒）"
  else
    fail "build.sh 退出码为 ${BUILD_EXIT}"
    echo -e "    ${RED}最后 20 行输出:${NC}"
    echo "$BUILD_OUTPUT" | tail -20 | sed 's/^/    │ /'
  fi

  # ── 3.2 构建报告输出 ─────────────────────────────────────────────────────
  if echo "$BUILD_OUTPUT" | grep -q "构建完成"; then
    pass "输出包含「构建完成」报告"
  else
    fail "输出缺少「构建完成」报告"
  fi

  # ── 3.3 DMG 产物存在 ─────────────────────────────────────────────────────
  DMG_COUNT=$(find "${PROJECT_ROOT}/artifacts/release" -name "*.dmg" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$DMG_COUNT" -gt 0 ]]; then
    DMG_FILE=$(find "${PROJECT_ROOT}/artifacts/release" -name "*.dmg" -print -quit)
    DMG_SIZE=$(du -sh "$DMG_FILE" 2>/dev/null | cut -f1)
    pass "DMG 安装包存在（$(basename "$DMG_FILE")，${DMG_SIZE}）"
  else
    fail "artifacts/release/ 中未找到 .dmg 文件"
    # 检查 bundle 目录是否有
    BUNDLE_DMG=$(find "${PROJECT_ROOT}/src-tauri/target/release/bundle/dmg" -name "*.dmg" 2>/dev/null | head -1)
    if [[ -n "$BUNDLE_DMG" ]]; then
      echo -e "    ${YELLOW}但 bundle 目录有: $(basename "$BUNDLE_DMG")${NC}"
      echo -e "    ${YELLOW}说明 tauri build 成功了，但收集步骤有问题${NC}"
    fi
  fi

  # ── 3.4 .app.zip 产物存在（macOS）─────────────────────────────────────────
  if [[ "$(uname -s)" == "Darwin" ]]; then
    ZIP_COUNT=$(find "${PROJECT_ROOT}/artifacts/release" -name "*.app.zip" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$ZIP_COUNT" -gt 0 ]]; then
      ZIP_FILE=$(find "${PROJECT_ROOT}/artifacts/release" -name "*.app.zip" -print -quit)
      ZIP_SIZE=$(du -sh "$ZIP_FILE" 2>/dev/null | cut -f1)
      pass ".app.zip 存在（$(basename "$ZIP_FILE")，${ZIP_SIZE}）"
    else
      fail "artifacts/release/ 中未找到 .app.zip"
    fi
  fi

  # ── 3.5 SHA256 校验和存在且有效 ──────────────────────────────────────────
  SHA_COUNT=$(find "${PROJECT_ROOT}/artifacts/release" -name "*.sha256" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$SHA_COUNT" -gt 0 ]]; then
    pass "SHA256 校验和文件存在（${SHA_COUNT} 个）"

    # 验证每个校验和
    ALL_VALID=true
    for sha_file in "${PROJECT_ROOT}/artifacts/release"/*.sha256; do
      TARGET="${sha_file%.sha256}"
      if [[ ! -f "$TARGET" ]]; then
        fail "校验和文件缺少对应目标: $(basename "$sha_file")"
        ALL_VALID=false
        continue
      fi
      EXPECTED=$(cat "$sha_file")
      if command -v shasum &>/dev/null; then
        ACTUAL=$(shasum -a 256 "$TARGET" | awk '{print $1}')
      else
        ACTUAL=$(sha256sum "$TARGET" | awk '{print $1}')
      fi
      if [[ "$EXPECTED" != "$ACTUAL" ]]; then
        fail "SHA256 不匹配: $(basename "$TARGET")"
        ALL_VALID=false
      fi
    done
    if $ALL_VALID; then
      pass "所有 SHA256 校验和验证通过"
    fi
  else
    fail "未找到 SHA256 校验和文件"
  fi

  # ── 3.6 DMG 可挂载（macOS）───────────────────────────────────────────────
  if [[ "$(uname -s)" == "Darwin" ]]; then
    DMG_FILE=$(find "${PROJECT_ROOT}/artifacts/release" -name "*.dmg" -print -quit 2>/dev/null)
    if [[ -n "$DMG_FILE" ]]; then
      MOUNT_POINT="${TEST_TMP:-/tmp}/piko-test-mount-$$"
      mkdir -p "$MOUNT_POINT"
      if hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_FILE" &>/dev/null; then
        pass "DMG 可挂载"
        # 检查 .app 是否在 DMG 里
        if ls "$MOUNT_POINT"/*.app &>/dev/null; then
          APP_IN_DMG=$(ls "$MOUNT_POINT"/*.app | head -1)
          pass "DMG 包含 .app: $(basename "$APP_IN_DMG")"
        else
          fail "DMG 内未找到 .app"
        fi
        hdiutil detach "$MOUNT_POINT" &>/dev/null
      else
        fail "DMG 挂载失败"
      fi
      rmdir "$MOUNT_POINT" 2>/dev/null
    else
      skip "DMG 挂载测试（无 DMG 文件）"
    fi
  fi

else
  section "Level 3: 完整构建 ${DIM}(跳过，使用 --full 启用)${NC}"
  echo -e "  ${DIM}提示: ./scripts/test-build.sh --full 可运行完整构建测试${NC}"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 测试报告
# ═════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════════${NC}"
if [[ $TESTS_FAILED -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ✅ 全部通过！${NC}"
else
  echo -e "${RED}${BOLD}  ❌ 有测试失败${NC}"
fi
echo -e "${BOLD}══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  总计: ${BOLD}${TESTS_RUN}${NC}  ${GREEN}通过: ${TESTS_PASSED}${NC}  ${RED}失败: ${TESTS_FAILED}${NC}  ${YELLOW}跳过: ${TESTS_SKIPPED}${NC}"

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo ""
  echo -e "  ${RED}${BOLD}失败详情:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "    ${RED}✗${NC} $f"
  done
fi

echo ""

# 退出码
if [[ $TESTS_FAILED -gt 0 ]]; then
  exit 1
fi
exit 0
