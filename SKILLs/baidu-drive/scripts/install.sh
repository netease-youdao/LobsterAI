#!/bin/bash
# bdpan CLI 一键安装脚本
# 自动检测平台架构并下载对应的安装器

set -e

# bdpan CLI 安装器版本（与 CDN 发布版本保持同步）
VERSION="3.8.4"
MIN_CLI_VERSION="3.9.0"
CDN_BASE="https://issuecdn.baidupcs.com/issue/netdisk/ai-bdpan/installer/${VERSION}"

# 按平台返回安装器 SHA256 校验值（兼容 bash 3.2+，替代 declare -A）
get_checksum() {
    case "$1" in
        darwin-amd64)  echo "cc6b10d4afea9baad77c68dadea6b9e4ecd7f8815cf364ebe6be0e51648e4623" ;;
        darwin-arm64)  echo "a0c395a83f9abc8f1423c30b21dfae73819376f7b1822d3bd4d3de62392c4c0c" ;;
        linux-amd64)   echo "02050e9a5ed5c5ddc314bf920c103238a669366a130e3bd43a125d83fdd00548" ;;
        linux-arm64)   echo "abb39a1f7dc0bf44883bbb30b057e6e65c5db64ffdce7c2ae92dea60a136362a" ;;
        windows-amd64) echo "194f5174bbb3d9260cc5b7d465c4f98d6b9279e028db136dc1e57cc3bc1f49a0" ;;
        *)             echo "" ;;
    esac
}

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_install_welcome() {
    echo ""
    echo "百度网盘 Skill 已安装完成。"
    echo "下一步：在 Agent 对话中确认安全说明，再打开最新授权链接；网页授权后直接发送需求。"
    echo "通过 Agent 使用时，Agent 会展示授权链接及使用示例；查看登录入口："
    echo "  bash \"${CLAUDE_SKILL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}/scripts/login.sh\""
    echo "登录成功后，即可直接用自然语言管理网盘文件。"
    echo ""
}

# 安装器会获取线上 CLI，安装完成后仍需检查实际版本。
verify_cli_version() {
    local cli="$1" version_output
    version_output=$("$cli" version --no-check-update 2>/dev/null) || {
        local status=$?
        log_error "无法读取 bdpan CLI 版本，请检查安装后重试。"
        return "$status"
    }
    version_output=${version_output%%$'\n'*}
    if [[ ! "$version_output" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        log_error "无法识别 bdpan CLI 版本，请安装 bdpan >= ${MIN_CLI_VERSION}。"
        return 1
    fi
    CLI_VERSION="${BASH_REMATCH[0]}"
    if (( 10#${BASH_REMATCH[1]} < 3 || (10#${BASH_REMATCH[1]} == 3 && 10#${BASH_REMATCH[2]} < 9) )); then
        log_error "当前 bdpan CLI ${CLI_VERSION} 不支持此登录方式，请升级到 bdpan >= ${MIN_CLI_VERSION} 后重试。"
        return 1
    fi
}

# 检测操作系统
detect_os() {
    case "$(uname -s)" in
        Darwin)
            echo "darwin"
            ;;
        Linux)
            echo "linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "windows"
            ;;
        *)
            log_error "不支持的操作系统: $(uname -s)"
            exit 1
            ;;
    esac
}

# 检测架构
detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)
            echo "amd64"
            ;;
        arm64|aarch64)
            echo "arm64"
            ;;
        *)
            log_error "不支持的架构: $(uname -m)"
            exit 1
            ;;
    esac
}

# 主函数
main() {
    local force="no"
    local skip_download="no"

    # 解析参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            --yes|-y|--force|-f)
                force="yes"
                shift
                ;;
            --skip-download)
                skip_download="yes"
                shift
                ;;
            --version|-v)
                echo "bdpan install script v${VERSION}"
                exit 0
                ;;
            --help|-h)
                echo "用法: $0 [选项]"
                echo ""
                echo "选项:"
                echo "  --yes, -y           非交互式安装（跳过确认）"
                echo "  --force, -f         强制重新安装"
                echo "  --skip-download     跳过下载，直接使用本地 bdpan 工具"
                echo "                      （需设置 BDPAN_BIN 环境变量）"
                echo "  --version           显示版本信息"
                echo "  --help              显示帮助信息"
                echo ""
                echo "环境变量:"
                echo "  BDPAN_BIN           指定本地 bdpan 工具路径"
                echo ""
                echo "示例:"
                echo "  $0                          # 交互式安装"
                echo "  $0 --yes                    # 非交互式安装"
                echo "  BDPAN_BIN=/path/to/bdpan $0 --skip-download"
                echo "                              # 使用本地工具"
                exit 0
                ;;
            *)
                log_error "未知参数: $1"
                echo "使用 --help 查看帮助信息"
                exit 1
                ;;
        esac
    done

    # 检查是否使用本地 bdpan 工具
    if [ "$skip_download" = "yes" ]; then
        if [ -z "$BDPAN_BIN" ]; then
            log_error "--skip-download 需要 BDPAN_BIN 环境变量指定本地工具路径"
            echo "示例: BDPAN_BIN=/path/to/bdpan $0 --skip-download"
            exit 1
        fi
        if [ ! -x "$BDPAN_BIN" ]; then
            log_error "指定的 bdpan 工具不存在或不可执行: $BDPAN_BIN"
            exit 1
        fi

        log_info "使用本地 bdpan 工具: $BDPAN_BIN"
        verify_cli_version "$BDPAN_BIN"
        log_info "bdpan CLI 版本: ${CLI_VERSION}"
        log_info "✓ 配置完成！"
        echo ""
        print_install_welcome
        echo ""
        exit 0
    fi

    # 检测平台
    local os=$(detect_os)
    local arch=$(detect_arch)

    log_info "检测到平台: ${os}/${arch}"

    # 检查是否已安装
    if command -v bdpan &> /dev/null; then
        local current_version=$(bdpan version 2>/dev/null | head -1 || echo "unknown")
        log_warn "bdpan CLI 已安装 (版本: ${current_version})"
        if [ "$force" = "yes" ]; then
            log_info "强制重新安装..."
        else
            read -p "是否要重新安装? [y/N] " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "取消安装"
                exit 0
            fi
        fi
    fi

    # 构建安装器文件名和 URL
    local installer_name="bdpan-installer-${os}-${arch}"
    local installer_url="${CDN_BASE}/${installer_name}"

    # Windows 特殊处理
    if [ "$os" = "windows" ]; then
        installer_name="${installer_name}.exe"
        installer_url="${CDN_BASE}/${installer_name}"
    fi

    log_info "正在下载 bdpan CLI 安装器 (v${VERSION})..."
    log_info "下载地址: ${installer_url}"

    # 下载并执行安装器（使用 --yes 非交互模式）
    if command -v curl &> /dev/null; then
        curl -fsSL -O "${installer_url}"
    elif command -v wget &> /dev/null; then
        wget -q "${installer_url}"
    else
        log_error "未找到 curl 或 wget，请手动下载安装器"
        exit 1
    fi

    # 添加执行权限（非 Windows）
    if [ "$os" != "windows" ]; then
        chmod +x "${installer_name}"
    fi

    log_info "安装器下载完成，正在校验完整性..."

    # SHA256 完整性校验
    local platform_key="${os}-${arch}"
    local expected_checksum
    expected_checksum="$(get_checksum "$platform_key")"
    if [ -n "$expected_checksum" ]; then
        local actual_checksum=""
        if command -v sha256sum &> /dev/null; then
            actual_checksum=$(sha256sum "${installer_name}" | awk '{print $1}')
        elif command -v shasum &> /dev/null; then
            actual_checksum=$(shasum -a 256 "${installer_name}" | awk '{print $1}')
        else
            log_warn "未找到 sha256sum/shasum 工具，跳过完整性校验"
        fi

        if [ -n "$actual_checksum" ]; then
            if [ "$actual_checksum" != "$expected_checksum" ]; then
                log_error "SHA256 校验失败！文件可能被篡改"
                log_error "  期望: ${expected_checksum}"
                log_error "  实际: ${actual_checksum}"
                rm -f "${installer_name}"
                exit 1
            fi
            log_info "SHA256 校验通过"
        fi
    else
        log_warn "当前平台 ${platform_key} 无预置校验值，跳过完整性校验"
    fi

    # 执行安装器（非交互模式）
    ./${installer_name} --yes

    # 清理安装器
    rm -f "${installer_name}"

    # 验证安装
    log_info "验证安装..."
    if command -v bdpan &> /dev/null; then
        # 注册到版本管理系统，使 bdpan update 能正常工作
        log_info "注册到版本管理系统..."
        bdpan install --force 2>/dev/null || log_warn "版本注册跳过（不影响使用）"
        verify_cli_version bdpan
        log_info "✓ bdpan CLI 安装成功！(版本: ${CLI_VERSION})"

        echo ""

        # 安全免责声明
        echo -e "${RED}┌──────────────────────────────────────────────────────────────┐${NC}"
        echo -e "${RED}│              ⚠️  baidu drive 安全须知 & 免责声明                │${NC}"
        echo -e "${RED}├──────────────────────────────────────────────────────────────┤${NC}"
        echo -e "${RED}│${NC} 1. 请备份网盘重要数据，谨慎操作。                            ${RED}│${NC}"
        echo -e "${RED}│${NC}    请务必【备份】网盘重要数据。                               ${RED}│${NC}"
        echo -e "${RED}│${NC} 2. [行为负责] AI Agent 行为具有不可预测性，请实时             ${RED}│${NC}"
        echo -e "${RED}│${NC}    【人工审核】指令执行过程，对执行后果负责。                  ${RED}│${NC}"
        echo -e "${RED}│${NC} 3. [安全提醒] 严禁在他人、公用或不可信的环境中                ${RED}│${NC}"
        echo -e "${RED}│${NC}    扫码授权，以免网盘数据被窃取！                              ${RED}│${NC}"
        echo -e "${RED}│${NC}    在公共环境使用完毕后，请务必执行                             ${RED}│${NC}"
        echo -e "${RED}│${NC}    【bdpan logout】 彻底清除授权。                             ${RED}│${NC}"
        echo -e "${RED}│${NC} 4. [严禁泄露] 请严格保护配置文件与 Token，                    ${RED}│${NC}"
        echo -e "${RED}│${NC}    切勿在公开仓库或对话中暴露！                                ${RED}│${NC}"
        echo -e "${RED}├──────────────────────────────────────────────────────────────┤${NC}"
        echo -e "${RED}│${NC} 使用本工具即代表您已阅读并认可上述条款。数据安全，人人有责。  ${RED}│${NC}"
        echo -e "${RED}└──────────────────────────────────────────────────────────────┘${NC}"
        echo ""

        print_install_welcome
    else
        log_error "安装失败，请检查 PATH 是否包含 ~/.local/bin"
        echo "可以手动添加: export PATH=\"\$HOME/.local/bin:\$PATH\""
        exit 1
    fi
}

# 执行主函数
main "$@"
