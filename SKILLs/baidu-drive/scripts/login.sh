#!/bin/bash
# 非交互准备凭据；需要网页授权时返回 JSON 并退出，供 Agent 展示。
set -eu

CONFIRMED=no
CONTINUE_TASK=no
while [[ $# -gt 0 ]]; do
    case "$1" in
        --confirmed) CONFIRMED=yes ;;
        --continue-task|--quiet|--no-welcome) CONTINUE_TASK=yes ;;
        --help|-h)
            printf '%s\n' "用法: $0 [--confirmed] [--continue-task]" \
                '默认仅复用凭据或单次领取；需新链接时返回 confirmation_required。' \
                '--confirmed：Agent 已取得本会话、同一授权流程的安全确认。' \
                '--continue-task：仅成功时静默；授权状态与错误始终保留。' \
                '不等待终端输入，不轮询；旧 --yes 不代表本次授权确认。'
            exit 0
            ;;
        *)
            printf '%s\n' '不支持的选项；请使用 --help。旧 --yes 不能代替本会话授权确认。' >&2
            exit 1
            ;;
    esac
    shift
done

if ! command -v bdpan >/dev/null 2>&1; then
    printf '%s\n' '未找到 bdpan，请先按 Skill 安装流程安装。' >&2
    exit 1
fi

# 检查 CLI 是否提供本 Skill 所需的统一授权参数。
if ! login_help=$(bdpan login --help --no-check-update 2>/dev/null) ||
    [[ "$login_help" != *--auth-confirmed* || "$login_help" != *--auth-flow* ]]; then
    printf '%s\n' '当前 CLI 未提供统一授权入口，请确认已安装配套发布包；不会调用旧浏览器登录或自动升级。' >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_VERSION=$(tr -d '[:space:]' < "$SCRIPT_DIR/../VERSION")
if [ -z "$SKILL_VERSION" ]; then
    printf '%s\n' 'Skill VERSION 为空，请检查安装包。' >&2
    exit 1
fi
args=(login --json --no-check-update --skill-name baidu-drive
    --skill-version "$SKILL_VERSION" --auth-flow cli)
if [ "$CONFIRMED" = yes ]; then
    args+=(--auth-confirmed)
fi

# 复用可用 JSON 运行时，不以退出码 0 或文本匹配代替成功协议。
validate_authenticated() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import json, sys
try:
    value = json.load(sys.stdin)
    valid = (isinstance(value, dict) and type(value.get("code")) is int
             and value["code"] == 0 and isinstance(value.get("data"), dict)
             and value["data"].get("status") == "authenticated")
except (ValueError, TypeError):
    valid = False
sys.exit(0 if valid else 1)' 2>/dev/null
    elif command -v node >/dev/null 2>&1; then
        node -e 'let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
    try {
        const value = JSON.parse(input);
        const valid = value && value.code === 0 && value.data
            && value.data.status === "authenticated";
        process.exit(valid ? 0 : 1);
    } catch (error) { process.exit(1); }
});' 2>/dev/null
    else
        printf '%s\n' '缺少 python3 或 Node.js，无法核验授权结果；已停止。' >&2
        return 1
    fi
}

# stdout 完整保留 CLI JSON；不把授权中断改写为普通失败，不再次领取。
status=0
result=$(bdpan "${args[@]}" </dev/null) || status=$?
if [ "$status" -eq 0 ] && ! printf '%s\n' "$result" | validate_authenticated; then
    printf '%s\n' 'CLI 未返回有效的登录成功结果，已停止当前操作。' >&2
    status=1
fi
if [ "$status" -ne 0 ] || [ "$CONTINUE_TASK" != yes ]; then
    printf '%s\n' "$result"
fi
exit "$status"
