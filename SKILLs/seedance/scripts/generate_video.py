#!/usr/bin/env python3
"""
Seedance 视频生成脚本
支持文本生成视频（T2V）、图片生成视频（I2V）、音画同步视频生成
"""

import os
import sys
import time
import argparse
import requests
from pathlib import Path
from typing import List, Dict, Optional

# ==================== 配置 ====================

API_KEY = os.environ.get("ARK_API_KEY")
BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"

# 默认参数
DEFAULT_MODEL = "doubao-seedance-1-5-pro-251215"
DEFAULT_DURATION = 5
DEFAULT_RATIO = "adaptive"
DEFAULT_POLL_INTERVAL = 5
DEFAULT_TIMEOUT = 300

# ==================== 工具函数 ====================

def print_error(message: str) -> None:
    """打印错误信息到stderr"""
    print(f"错误: {message}", file=sys.stderr)


def print_info(message: str, end: str = '\n') -> None:
    """打印信息到stderr（不影响stdout）"""
    print(message, file=sys.stderr, end=end)


def validate_config() -> bool:
    """验证API配置"""
    if not API_KEY:
        print_error("未设置环境变量 ARK_API_KEY")
        print_info("")
        print_info("请通过环境变量配置 API Key：")
        print_info("")
        print_info("macOS/Linux:")
        print_info("  export ARK_API_KEY=\"你的API密钥\"")
        print_info("  # 或添加到 ~/.zshrc 或 ~/.bashrc 以永久生效")
        print_info("  echo 'export ARK_API_KEY=\"你的API密钥\"' >> ~/.zshrc")
        print_info("  source ~/.zshrc")
        print_info("")
        print_info("Windows PowerShell:")
        print_info("  $env:ARK_API_KEY=\"你的API密钥\"")
        print_info("  # 或设置系统环境变量以永久生效")
        print_info("")
        print_info("获取 API Key：")
        print_info("  访问 https://console.volcengine.com/ark/region:ark+cn-beijing/apikey")
        return False
    return True


def validate_duration(duration: int, model: str) -> bool:
    """验证视频时长参数"""
    if "1-5-pro" in model:
        if duration < 4 or duration > 12:
            print_error(f"模型 {model} 的 duration 必须在 4-12 秒之间")
            return False
    else:
        if duration < 2 or duration > 12:
            print_error(f"模型 {model} 的 duration 必须在 2-12 秒之间")
            return False
    return True


# ==================== API 调用函数 ====================

def process_image_path(image_path: str) -> str:
    """
    处理图片路径，支持本地文件、URL和Base64

    Args:
        image_path: 图片路径（本地文件路径或URL）

    Returns:
        处理后的图片URL（data:image base64编码 或 https://网络URL）
    """
    import base64

    # 如果是HTTP/HTTPS URL，直接返回
    if image_path.startswith(('http://', 'https://')):
        return image_path

    # 如果已经是data URL，直接返回
    if image_path.startswith('data:'):
        return image_path

    # 处理file://协议
    if image_path.startswith('file://'):
        image_path = image_path[7:]  # 移除 file:// 前缀

    # 否则当作本地文件处理
    abs_path = Path(image_path).absolute()

    # 检查文件是否存在
    if not abs_path.exists():
        raise FileNotFoundError(f"图片文件不存在: {abs_path}")

    # 检查是否是文件
    if not abs_path.is_file():
        raise ValueError(f"路径不是文件: {abs_path}")

    # 检查文件扩展名并确定MIME类型
    ext_to_mime = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
        '.heic': 'image/heic'
    }

    ext = abs_path.suffix.lower()
    if ext not in ext_to_mime:
        print_info(f"警告: {abs_path.name} 可能不是有效的图片格式")
        mime_type = 'image/jpeg'  # 默认使用jpeg
    else:
        mime_type = ext_to_mime[ext]

    # 读取文件并转换为Base64
    with open(abs_path, 'rb') as f:
        image_data = f.read()
        base64_data = base64.b64encode(image_data).decode('utf-8')

    # 返回data URL格式
    return f"data:{mime_type};base64,{base64_data}"


def create_video_task(
    prompt: str,
    image_paths: Optional[List[str]] = None,
    model: str = DEFAULT_MODEL,
    duration: int = DEFAULT_DURATION,
    ratio: str = DEFAULT_RATIO,
    generate_audio: bool = False,
    watermark: bool = True
) -> str:
    """
    创建视频生成任务

    Args:
        prompt: 视频描述提示词
        image_paths: 参考图片路径列表（支持本地文件、URL）
        model: 模型ID
        duration: 视频时长（秒）
        ratio: 宽高比
        generate_audio: 是否生成音频
        watermark: 是否添加水印

    Returns:
        task_id: 任务ID

    Raises:
        Exception: API调用失败
    """
    # 构建content数组
    content = [{"type": "text", "text": prompt}]

    # 添加图片
    if image_paths:
        for img_path in image_paths:
            try:
                processed_url = process_image_path(img_path)
                content.append({
                    "type": "image_url",
                    "image_url": {"url": processed_url}
                })
            except (FileNotFoundError, ValueError) as e:
                raise Exception(f"图片处理失败: {str(e)}")

    # 构建请求payload
    payload = {
        "model": model,
        "content": content,
        "duration": duration,
        "ratio": ratio,
        "generate_audio": generate_audio,
        "watermark": watermark
    }

    print_info(f"正在提交任务...")
    print_info(f"  模型: {model}")
    print_info(f"  时长: {duration}秒")
    print_info(f"  宽高比: {ratio}")
    if image_paths:
        print_info(f"  参考图片: {len(image_paths)}张")
        for i, img in enumerate(image_paths, 1):
            if img.startswith('file://'):
                print_info(f"    [{i}] 本地文件: {img[7:]}")
            else:
                print_info(f"    [{i}] {img}")
    if generate_audio:
        print_info(f"  音频: 启用")

    try:
        response = requests.post(
            f"{BASE_URL}/contents/generations/tasks",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {API_KEY}"
            },
            json=payload,
            timeout=30
        )

        # 处理错误响应
        if response.status_code != 200:
            error_msg = f"HTTP {response.status_code}"
            try:
                error_data = response.json()
                if "error" in error_data:
                    error_detail = error_data["error"]
                    if isinstance(error_detail, dict):
                        error_msg = error_detail.get("message", error_msg)
                    else:
                        error_msg = str(error_detail)
            except:
                pass

            # 特殊错误处理
            if response.status_code == 401:
                raise Exception(f"认证失败：API Key 无效或已过期\n请检查 ARK_API_KEY 配置")
            elif response.status_code == 403:
                raise Exception(f"权限不足：请确认 API Key 有视频生成权限")
            elif response.status_code == 429:
                raise Exception(f"请求过于频繁：已超过限流配额\n请等待1分钟后重试")
            elif response.status_code == 400:
                raise Exception(f"参数错误：{error_msg}\n请检查提示词和参数设置")
            else:
                raise Exception(f"任务创建失败：{error_msg}")

        result = response.json()
        task_id = result.get("id")

        if not task_id:
            raise Exception("API 返回格式错误：缺少任务ID")

        return task_id

    except requests.exceptions.Timeout:
        raise Exception("请求超时：网络连接超时，请检查网络设置")
    except requests.exceptions.ConnectionError:
        raise Exception("连接失败：无法连接到火山方舟服务器")
    except Exception as e:
        if "任务创建失败" in str(e) or "认证失败" in str(e) or "权限不足" in str(e):
            raise
        raise Exception(f"任务创建失败：{str(e)}")


def poll_task_status(
    task_id: str,
    poll_interval: int = DEFAULT_POLL_INTERVAL,
    timeout: int = DEFAULT_TIMEOUT
) -> Dict:
    """
    轮询任务状态直到完成

    Args:
        task_id: 任务ID
        poll_interval: 轮询间隔（秒）
        timeout: 最大等待时间（秒）

    Returns:
        result: 完整的任务结果

    Raises:
        TimeoutError: 超时
        Exception: 任务失败或查询失败
    """
    start_time = time.time()
    retry_count = 0
    max_retries = 3

    print_info(f"")
    print_info(f"等待视频生成完成...")
    print_info(f"任务ID: {task_id}")
    print_info(f"(通常需要 30-120 秒，请耐心等待)")

    while True:
        elapsed = int(time.time() - start_time)

        # 检查超时
        if elapsed > timeout:
            raise TimeoutError(
                f"任务超时（{timeout}秒）\n"
                f"任务ID: {task_id}\n"
                f"你可以稍后通过控制台查看任务结果"
            )

        try:
            # 查询状态
            response = requests.get(
                f"{BASE_URL}/contents/generations/tasks/{task_id}",
                headers={
                    "Authorization": f"Bearer {API_KEY}"
                },
                timeout=10
            )

            if response.status_code != 200:
                retry_count += 1
                if retry_count >= max_retries:
                    raise Exception(f"状态查询失败 (HTTP {response.status_code})")
                print_info(f"[{elapsed}s] 查询失败，重试中...")
                time.sleep(2)
                continue

            # 重置重试计数
            retry_count = 0

            result = response.json()
            status = result.get("status")

            # 打印进度
            status_zh = {
                "queued": "排队中",
                "running": "生成中",
                "succeeded": "完成",
                "failed": "失败"
            }.get(status, status)

            print_info(f"\r[{elapsed}s] 状态: {status_zh}...", end='')

            # 检查状态
            if status == "succeeded":
                print_info("")  # 换行
                return result
            elif status == "failed":
                error_msg = "未知错误"
                if "error" in result:
                    error_detail = result["error"]
                    if isinstance(error_detail, dict):
                        error_msg = error_detail.get("message", error_msg)
                    else:
                        error_msg = str(error_detail)
                raise Exception(f"任务失败：{error_msg}")

            # 等待后重试
            time.sleep(poll_interval)

        except requests.exceptions.Timeout:
            retry_count += 1
            if retry_count >= max_retries:
                raise Exception("状态查询超时：网络不稳定")
            print_info(f"[{elapsed}s] 查询超时，重试中...")
            time.sleep(2)
        except requests.exceptions.ConnectionError:
            retry_count += 1
            if retry_count >= max_retries:
                raise Exception("连接失败：无法连接到服务器")
            print_info(f"[{elapsed}s] 连接失败，重试中...")
            time.sleep(2)
        except Exception as e:
            if "任务失败" in str(e):
                raise
            if retry_count >= max_retries:
                raise
            retry_count += 1
            print_info(f"[{elapsed}s] 错误: {str(e)}，重试中...")
            time.sleep(2)


def download_video(video_url: str, output_path: Path) -> None:
    """
    下载生成的视频

    Args:
        video_url: 视频下载URL
        output_path: 输出文件路径

    Raises:
        Exception: 下载失败
    """
    print_info("")
    print_info("正在下载视频...")

    try:
        response = requests.get(video_url, stream=True, timeout=120)
        response.raise_for_status()

        # 确保输出目录存在
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # 获取文件大小
        total_size = int(response.headers.get('content-length', 0))
        downloaded = 0

        # 写入文件
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)

                    # 显示进度
                    if total_size > 0:
                        percent = int(downloaded * 100 / total_size)
                        mb_downloaded = downloaded / (1024 * 1024)
                        mb_total = total_size / (1024 * 1024)
                        print_info(
                            f"\r下载进度: {percent}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)",
                            end=''
                        )

        print_info("")  # 换行
        print_info(f"视频已保存: {output_path.absolute()}")

    except requests.exceptions.Timeout:
        raise Exception("下载超时：请检查网络连接")
    except requests.exceptions.HTTPError as e:
        raise Exception(f"下载失败 (HTTP {e.response.status_code})")
    except IOError as e:
        raise Exception(f"文件写入失败：{str(e)}")
    except Exception as e:
        raise Exception(f"下载失败：{str(e)}")


# ==================== 主函数 ====================

def main():
    parser = argparse.ArgumentParser(
        description="Seedance 视频生成 - 使用火山引擎 AI 模型生成视频",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  # 文本生成视频
  python3 generate_video.py --prompt "小猫在草地上玩耍"

  # 图片生成视频
  python3 generate_video.py --prompt "女孩睁眼微笑" --image "https://example.com/image.jpg"

  # 音画同步视频
  python3 generate_video.py --prompt "小鸟唱歌" --audio --duration 5

更多信息请查看 SKILL.md
        """
    )

    # 必需参数
    parser.add_argument(
        "--prompt",
        required=True,
        help="视频描述提示词（必需）"
    )

    # 可选参数 - 输入
    parser.add_argument(
        "--image",
        action="append",
        help="参考图片路径或URL（支持本地文件、file://协议、https://网络图片，可多次使用）"
    )

    # 可选参数 - 模型和生成设置
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"模型ID（默认: {DEFAULT_MODEL}）"
    )

    parser.add_argument(
        "--duration",
        type=int,
        default=DEFAULT_DURATION,
        help=f"视频时长，单位秒（默认: {DEFAULT_DURATION}，范围: 2-12）"
    )

    parser.add_argument(
        "--ratio",
        default=DEFAULT_RATIO,
        choices=["adaptive", "16:9", "9:16", "1:1"],
        help=f"宽高比（默认: {DEFAULT_RATIO}）"
    )

    parser.add_argument(
        "--audio",
        action="store_true",
        help="生成音频（仅 1.5 pro 支持）"
    )

    parser.add_argument(
        "--no-watermark",
        action="store_true",
        help="不添加水印"
    )

    # 可选参数 - 输出和控制
    parser.add_argument(
        "--output",
        default="generated_video.mp4",
        help="输出文件路径（默认: generated_video.mp4）"
    )

    parser.add_argument(
        "--poll-interval",
        type=int,
        default=DEFAULT_POLL_INTERVAL,
        help=f"状态查询间隔（秒）（默认: {DEFAULT_POLL_INTERVAL}）"
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help=f"最大等待时间（秒）（默认: {DEFAULT_TIMEOUT}）"
    )

    args = parser.parse_args()

    # 验证配置
    if not validate_config():
        sys.exit(1)

    # 验证参数
    if not validate_duration(args.duration, args.model):
        sys.exit(1)

    if args.poll_interval < 1 or args.poll_interval > 10:
        print_error("poll-interval 必须在 1-10 秒之间")
        sys.exit(1)

    if args.timeout < 60 or args.timeout > 600:
        print_error("timeout 必须在 60-600 秒之间")
        sys.exit(1)

    # 执行生成流程
    try:
        print_info("=" * 50)
        print_info("Seedance 视频生成")
        print_info("=" * 50)

        # Step 1: 创建任务
        task_id = create_video_task(
            prompt=args.prompt,
            image_paths=args.image,
            model=args.model,
            duration=args.duration,
            ratio=args.ratio,
            generate_audio=args.audio,
            watermark=not args.no_watermark
        )

        print_info(f"任务已创建: {task_id}")

        # Step 2: 轮询状态
        result = poll_task_status(
            task_id,
            poll_interval=args.poll_interval,
            timeout=args.timeout
        )

        # Step 3: 下载视频
        video_url = result.get("content", {}).get("video_url")

        if not video_url:
            raise Exception("API 返回格式错误：缺少 video_url")

        output_path = Path(args.output)
        download_video(video_url, output_path)

        # 输出成功信息到 stdout（供 Claude 读取）
        print_info("")
        print_info("=" * 50)
        print_info("生成成功！")
        print_info("=" * 50)

        print("视频生成成功！")
        print(f"任务ID: {task_id}")
        print(f"文件路径: {output_path.absolute()}")
        print(f"分辨率: {result.get('resolution', 'N/A')}")
        print(f"宽高比: {result.get('ratio', 'N/A')}")
        print(f"时长: {result.get('duration', 'N/A')}秒")
        print(f"帧率: {result.get('framespersecond', 'N/A')} fps")

        if result.get("content", {}).get("has_audio"):
            print("音频: 已包含")

    except KeyboardInterrupt:
        print_info("")
        print_info("用户中断")
        sys.exit(130)
    except Exception as e:
        print_info("")
        print_info("=" * 50)
        print_error(str(e))
        print_info("=" * 50)
        sys.exit(1)


if __name__ == "__main__":
    main()
