#!/usr/bin/env bash
# ============================================================================
# Piko 本地编译构建安装包脚本
# 用法:
#   ./scripts/build.sh              # 默认构建当前平台安装包
#   ./scripts/build.sh --clean      # 清理后重新构建
#   ./scripts/build.sh --debug      # 构建 Debug 版本（更快，不压缩）
#   ./scripts/build.sh --skip-deps  # 跳过 npm ci（已安装依赖时加速）
#   ./scripts/build.sh --bundle-only # 跳过前端构建，只打包 Rust/Tauri
# ============================================================================

set -euo pipefail

# ── 颜色定义 ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── 辅助函数 ─────────────────────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC}  $*" ; }
success() { echo -e "${GREEN}[ OK ]${NC} $*" ; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*" ; }
error()   { echo -e "${RED}[ERR ]${NC} $*" >&2 ; }
step()    { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}" ; }

# 错误陷阱：脚本意外退出时给出有用信息
trap 'error "脚本在第 $LINENO 行异常退出（exit code: $?）。请检查上方日志。"' ERR

banner() {
  echo -e "${BOLD}"
  cat << 'EOF'
  ____  _ _       _
 |  _ \(_) | ___ | |_ ___  _ __
 | |_) | | |/ _ \| __/ _ \| '__|
 |  __/| | | (_) | || (_) | |
 |_|   |_|_|\___/ \__\___/|_|
EOF
  echo -e "${NC}"
  info "开始编译构建 Piko 安装包..."
}

# ── 参数解析 ─────────────────────────────────────────────────────────────────
CLEAN=false
DEBUG=false
SKIP_DEPS=false
BUNDLE_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --clean)       CLEAN=true ;;
    --debug)       DEBUG=true ;;
    --skip-deps)   SKIP_DEPS=true ;;
    --bundle-only) BUNDLE_ONLY=true ;;
    -h|--help)
      echo "用法: ./scripts/build.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --clean       清理旧的构建产物后重新构建"
      echo "  --debug       构建 Debug 版本（编译更快，包体更大）"
      echo "  --skip-deps   跳过 npm ci（依赖已安装时使用）"
      echo "  --bundle-only 跳过前端构建，只执行 Tauri/Rust 打包"
      echo "  -h, --help    显示帮助信息"
      exit 0
      ;;
    *)
      error "未知参数: $arg"
      echo "使用 --help 查看帮助"
      exit 1
      ;;
  esac
done

# ── 项目根目录 ───────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
info "项目目录: ${PROJECT_ROOT}"

# ── 读取版本信息 ─────────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
PRODUCT_NAME="Piko"
BUILD_MODE=$($DEBUG && echo "debug" || echo "release")

banner
info "版本: ${BOLD}v${VERSION}${NC}"
info "模式: ${BOLD}${BUILD_MODE}${NC}"
info "平台: $(uname -s)-$(uname -m)"
info "时间: $(date '+%Y-%m-%d %H:%M:%S')"

# ── 环境检查 ─────────────────────────────────────────────────────────────────
step "1/5 检查构建环境"

check_command() {
  if ! command -v "$1" &>/dev/null; then
    error "未找到 $1，请先安装: $2"
    exit 1
  fi
  local ver
  ver=$("$1" --version 2>/dev/null | head -1) || ver="installed"
  success "$1 → ${ver}"
}

check_command "node"  "(https://nodejs.org)"
check_command "npm"   "(随 Node.js 安装)"
check_command "rustc" "(https://rustup.rs)"
check_command "cargo" "(随 Rust 安装)"

# 检查 Tauri CLI
if ! npx tauri --version &>/dev/null 2>&1; then
  error "未找到 Tauri CLI，请先运行: npm install"
  exit 1
fi
TAURI_VER=$(npx tauri --version 2>/dev/null || echo "unknown")
success "tauri-cli → ${TAURI_VER}"

# macOS 特殊检查
if [[ "$(uname -s)" == "Darwin" ]]; then
  export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-10.15}"
  export CXXFLAGS="${CXXFLAGS:-} -D_LIBCPP_DISABLE_AVAILABILITY"
  info "macOS Deployment Target: ${MACOSX_DEPLOYMENT_TARGET}"
  if xcode-select -p &>/dev/null; then
    success "Xcode CLT → $(xcode-select -p)"
  else
    warn "未检测到 Xcode Command Line Tools"
    info "如构建失败，请运行: xcode-select --install"
  fi
fi

# ── 清理（可选） ─────────────────────────────────────────────────────────────
if $CLEAN; then
  step "清理旧构建产物"

  info "清理 Rust 构建缓存..."
  (cd src-tauri && cargo clean 2>/dev/null) || true
  success "Rust 缓存已清理"

  info "清理前端 dist/..."
  rm -rf dist
  success "dist/ 已清理"
fi

# ── 安装前端依赖 ─────────────────────────────────────────────────────────────
if ! $BUNDLE_ONLY; then
  step "2/5 安装前端依赖"

  if $SKIP_DEPS; then
    info "跳过 npm ci（--skip-deps）"
  else
    info "运行 npm ci..."
    npm ci --no-audit --fund=false
    success "前端依赖安装完成"
  fi

  # ── 前端构建 ─────────────────────────────────────────────────────────────
  step "3/5 构建前端"

  info "运行 TypeScript 类型检查 + Vite 构建..."
  npm run build
  success "前端构建完成 → dist/"

  if [[ -d "dist" ]]; then
    DIST_SIZE=$(du -sh dist 2>/dev/null | cut -f1)
    success "前端产物大小: ${DIST_SIZE}"
  fi
else
  step "2/5 跳过前端依赖安装（--bundle-only）"
  step "3/5 跳过前端构建（--bundle-only）"
  warn "使用现有 dist/ 目录"
  if [[ ! -d "dist" ]]; then
    error "dist/ 目录不存在！请先运行完整构建（去掉 --bundle-only）"
    exit 1
  fi
fi

# ── Tauri 编译构建 ───────────────────────────────────────────────────────────
step "4/5 编译 Tauri 应用并打包"

info "执行 tauri build（可能需要几分钟）..."

BUILD_START=$(date +%s)

if $DEBUG; then
  npx tauri build --debug
else
  npx tauri build
fi

BUILD_END=$(date +%s)
BUILD_DURATION=$((BUILD_END - BUILD_START))
BUILD_MIN=$((BUILD_DURATION / 60))
BUILD_SEC=$((BUILD_DURATION % 60))

success "Tauri 编译完成！耗时: ${BUILD_MIN}分${BUILD_SEC}秒"

# ── 收集产物 ─────────────────────────────────────────────────────────────────
step "5/5 收集安装包产物"

BUNDLE_DIR="src-tauri/target/${BUILD_MODE}/bundle"
OUTPUT_DIR="artifacts/release"
mkdir -p "$OUTPUT_DIR"

# 架构标签
ARCH=$(uname -m)
case "$ARCH" in
  arm64)  ARCH_LABEL="aarch64" ;;
  x86_64) ARCH_LABEL="x86_64" ;;
  *)      ARCH_LABEL="$ARCH" ;;
esac

find "$OUTPUT_DIR" -maxdepth 1 -type f \
  \( -name "${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}*" -o -name "${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}*.sha256" \) \
  -delete

info "构建产物目录: ${BUNDLE_DIR}"
info "安装包输出到: ${OUTPUT_DIR}"
echo ""

# 先列出 bundle 目录下所有文件供调试
info "bundle 目录内容:"
if [[ -d "$BUNDLE_DIR" ]]; then
  find "$BUNDLE_DIR" -maxdepth 3 -type f \( -name "*.dmg" -o -name "*.app" -o -name "*.deb" \
    -o -name "*.AppImage" -o -name "*.rpm" -o -name "*.exe" -o -name "*.msi" \) \
    -exec ls -lh {} \; 2>/dev/null | while read -r line; do
    echo "           $line"
  done
else
  warn "bundle 目录不存在: ${BUNDLE_DIR}"
fi
echo ""

COPIED=0

# 通用复制函数：用 find 代替 glob，更可靠
collect_by_find() {
  local search_dir="$1"
  local name_pattern="$2"
  local suffix="$3"

  if [[ ! -d "$search_dir" ]]; then
    return 0
  fi

  while IFS= read -r -d '' file; do
    local target_name="${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}${suffix}"
    info "复制: $(basename "$file") → ${target_name}"
    cp -R "$file" "${OUTPUT_DIR}/${target_name}"

    # SHA256 校验和（只对文件，不对目录）
    if [[ -f "${OUTPUT_DIR}/${target_name}" ]]; then
      if command -v shasum &>/dev/null; then
        shasum -a 256 "${OUTPUT_DIR}/${target_name}" | awk '{print $1}' \
          > "${OUTPUT_DIR}/${target_name}.sha256"
      elif command -v sha256sum &>/dev/null; then
        sha256sum "${OUTPUT_DIR}/${target_name}" | awk '{print $1}' \
          > "${OUTPUT_DIR}/${target_name}.sha256"
      fi
    fi

    COPIED=$((COPIED + 1))
  done < <(find "$search_dir" -maxdepth 1 -name "$name_pattern" -print0 2>/dev/null)
}

# macOS 安装包
collect_by_find "${BUNDLE_DIR}/dmg"     "*.dmg"      ".dmg"

# macOS .app（压缩为 zip 方便分发）
while IFS= read -r -d '' app_path; do
  APP_NAME=$(basename "$app_path" .app)
  ZIP_NAME="${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}.app.zip"
  info "打包: ${APP_NAME}.app → ${ZIP_NAME}"
  # 用 ditto 压缩 macOS .app（保留资源 fork和权限）
  if command -v ditto &>/dev/null; then
    ditto -c -k --keepParent "$app_path" "${OUTPUT_DIR}/${ZIP_NAME}"
  else
    (cd "$(dirname "$app_path")" && zip -r - "$APP_NAME.app") > "${OUTPUT_DIR}/${ZIP_NAME}"
  fi
  if command -v shasum &>/dev/null; then
    shasum -a 256 "${OUTPUT_DIR}/${ZIP_NAME}" | awk '{print $1}' \
      > "${OUTPUT_DIR}/${ZIP_NAME}.sha256"
  elif command -v sha256sum &>/dev/null; then
    sha256sum "${OUTPUT_DIR}/${ZIP_NAME}" | awk '{print $1}' \
      > "${OUTPUT_DIR}/${ZIP_NAME}.sha256"
  fi
  COPIED=$((COPIED + 1))
done < <(find "${BUNDLE_DIR}/macos" -maxdepth 1 -name "*.app" -print0 2>/dev/null)

# Linux 安装包
collect_by_find "${BUNDLE_DIR}/appimage" "*.AppImage" ".AppImage"
collect_by_find "${BUNDLE_DIR}/deb"      "*.deb"     ".deb"
collect_by_find "${BUNDLE_DIR}/rpm"      "*.rpm"     ".rpm"

# Windows 安装包
collect_by_find "${BUNDLE_DIR}/nsis"     "*.exe"     ".exe"
collect_by_find "${BUNDLE_DIR}/msi"      "*.msi"     ".msi"

# ── 构建报告 ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ 构建完成！${NC}"
echo -e "${GREEN}${BOLD}══════════════════════════════════════════════════════════${NC}"
echo ""
info "版本:     ${BOLD}${VERSION}${NC}"
info "模式:     ${BOLD}${BUILD_MODE}${NC}"
info "耗时:     ${BOLD}${BUILD_MIN}分${BUILD_SEC}秒${NC}"
echo ""

if [[ $COPIED -gt 0 ]]; then
  success "已生成 ${BOLD}${COPIED}${NC} 个安装包文件:"
  echo ""
  shopt -s nullglob
  for f in "$OUTPUT_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}"*; do
    [[ "$f" == *.sha256 ]] && continue
    fsize=$(du -sh "$f" 2>/dev/null | cut -f1)
    fname=$(basename "$f")
    echo -e "  ${CYAN}●${NC} ${BOLD}${fname}${NC}  (${fsize})"
    if [[ -f "${f}.sha256" ]]; then
      echo -e "    SHA256: $(cat "${f}.sha256")"
    fi
  done
  shopt -u nullglob
  echo ""
  info "安装包所在目录（Finder 打开）:"
  echo -e "           ${CYAN}open ${OUTPUT_DIR}/${NC}"
  echo ""

  # 快速安装指引
  echo -e "  ${BOLD}快速安装:${NC}"
  shopt -s nullglob
  DMG_FILES=("$OUTPUT_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}"*.dmg)
  DEB_FILES=("$OUTPUT_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}"*.deb)
  EXE_FILES=("$OUTPUT_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}"*.exe)
  APP_ZIPS=("$OUTPUT_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH_LABEL}"*.app.zip)
  shopt -u nullglob

  if [[ ${#DMG_FILES[@]} -gt 0 ]]; then
    echo -e "    macOS DMG:  ${CYAN}open ${DMG_FILES[0]}${NC}"
  fi
  if [[ ${#APP_ZIPS[@]} -gt 0 ]]; then
    echo -e "    macOS APP:  ${CYAN}unzip ${APP_ZIPS[0]} -d /Applications/${NC}"
  fi
  if [[ ${#DEB_FILES[@]} -gt 0 ]]; then
    echo -e "    Linux DEB:  ${CYAN}sudo dpkg -i ${DEB_FILES[0]}${NC}"
  fi
  if [[ ${#EXE_FILES[@]} -gt 0 ]]; then
    echo -e "    Windows:    ${CYAN}start ${EXE_FILES[0]}${NC}"
  fi
else
  warn "未找到安装包文件！"
  echo ""
  info "请手动检查构建产物目录:"
  echo -e "           ${CYAN}find ${BUNDLE_DIR} -type f${NC}"
  echo ""
  info "常见原因:"
  echo "    1. tauri build 未真正完成（检查上方是否有编译错误）"
  echo "    2. bundle 目录为空（尝试 --clean 重新构建）"
fi
echo ""
