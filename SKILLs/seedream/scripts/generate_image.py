#!/usr/bin/env python3
"""
Seedream 图片生成脚本
支持文本生成图片（T2I）、图片编辑（I2I）、多图融合、组图生成
"""

import os
import sys
import argparse
import requests
import base64
from pathlib import Path
from typing import List, Optional

# ==================== 配置 ====================

API_KEY = os.environ.get("ARK_API_KEY")
BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"

# 默认参数
DEFAULT_MODEL = "doubao-seedream-4-5-251128"
DEFAULT_SIZE = "2K"

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
        print_info("=" * 70)
        print_info("快速设置 API Key：")
        print_info("=" * 70)
        print_info("")
        print_info("【macOS / Linux】")
        print_info("  # 当前终端临时生效")
        print_info("  export ARK_API_KEY=\"你的API密钥\"")
        print_info("")
        print_info("  # 永久生效（推荐）")
        print_info("  echo 'export ARK_API_KEY=\"你的API密钥\"' >> ~/.zshrc")
        print_info("  source ~/.zshrc")
        print_info("")
        print_info("【Windows PowerShell】")
        print_info("  # 当前会话临时生效")
        print_info("  $env:ARK_API_KEY=\"你的API密钥\"")
        print_info("")
        print_info("  # 永久生效（推荐）")
        print_info("  [System.Environment]::SetEnvironmentVariable('ARK_API_KEY', '你的API密钥', 'User')")
        print_info("")
        print_info("【验证设置】")
        print_info("  # macOS/Linux")
        print_info("  echo $ARK_API_KEY")
        print_info("")
        print_info("  # Windows PowerShell")
        print_info("  echo $env:ARK_API_KEY")
        print_info("")
        print_info("=" * 70)
        print_info("获取 API Key：")
        print_info("  https://console.volcengine.com/ark/region:ark+cn-beijing/apikey")
        print_info("=" * 70)
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


def generate_image(
    prompt: str,
    image_paths: Optional[List[str]] = None,
    model: str = DEFAULT_MODEL,
    size: str = DEFAULT_SIZE,
    watermark: bool = True,
    sequential: bool = False,
    max_images: int = 1,
    enable_search: bool = False
) -> dict:
    """
    生成图片（同步模式）

    Args:
        prompt: 图片描述提示词
        image_paths: 参考图片路径列表（支持本地文件、URL）
        model: 模型ID
        size: 图片尺寸
        watermark: 是否添加水印
        sequential: 是否生成组图
        max_images: 组图数量
        enable_search: 是否启用联网搜索

    Returns:
        API响应结果

    Raises:
        Exception: API调用失败
    """
    # 构建请求payload
    payload = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "response_format": "url",
        "watermark": watermark
    }

    # 添加图片
    if image_paths:
        if len(image_paths) == 1:
            try:
                processed_url = process_image_path(image_paths[0])
                payload["image"] = processed_url
            except (FileNotFoundError, ValueError) as e:
                raise Exception(f"图片处理失败: {str(e)}")
        else:
            try:
                processed_urls = [process_image_path(img) for img in image_paths]
                payload["image"] = processed_urls
                payload["sequential_image_generation"] = "disabled"  # 多图融合
            except (FileNotFoundError, ValueError) as e:
                raise Exception(f"图片处理失败: {str(e)}")

    # 组图生成
    if sequential:
        payload["sequential_image_generation"] = "auto"
        payload["sequential_image_generation_options"] = {"max_images": max_images}

    # 联网搜索
    if enable_search:
        payload["enable_online_search"] = True
        payload["model"] = "doubao-seedream-5-0-260128"  # 使用 5.0 lite

    print_info(f"正在生成图片...")
    print_info(f"  模型: {payload['model']}")
    print_info(f"  尺寸: {size}")
    if image_paths:
        print_info(f"  参考图片: {len(image_paths)}张")
        for i, img in enumerate(image_paths, 1):
            if img.startswith('file://'):
                print_info(f"    [{i}] 本地文件: {img[7:]}")
            elif not img.startswith(('http://', 'https://', 'data:')):
                print_info(f"    [{i}] 本地文件: {img}")
            else:
                print_info(f"    [{i}] {img[:80]}...")
    if sequential:
        print_info(f"  组图数量: {max_images}张")
    if enable_search:
        print_info(f"  联网搜索: 启用")
    print_info(f"  (通常需要 30-60 秒，请稍候...)")
    print_info("")

    try:
        response = requests.post(
            f"{BASE_URL}/images/generations",  # 同步 endpoint
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {API_KEY}"
            },
            json=payload,
            timeout=120  # 增加超时时间
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
                raise Exception(f"权限不足：请确认 API Key 有图片生成权限")
            elif response.status_code == 429:
                raise Exception(f"请求过于频繁：已超过限流配额\n请等待1分钟后重试")
            elif response.status_code == 400:
                raise Exception(f"参数错误：{error_msg}\n请检查提示词和参数设置")
            else:
                raise Exception(f"生成失败：{error_msg}")

        return response.json()

    except requests.exceptions.Timeout:
        raise Exception("请求超时：网络连接超时或生成时间过长\n建议：增加超时时间或稍后重试")
    except requests.exceptions.ConnectionError:
        raise Exception("连接失败：无法连接到火山方舟服务器\n请检查网络连接")
    except Exception as e:
        if "生成失败" in str(e) or "认证失败" in str(e) or "权限不足" in str(e):
            raise
        raise Exception(f"生成失败：{str(e)}")


def download_image(image_url: str, output_path: Path, index: int = 1, total: int = 1) -> None:
    """
    下载生成的图片

    Args:
        image_url: 图片下载URL
        output_path: 输出文件路径
        index: 当前图片索引（组图时使用）
        total: 总图片数量

    Raises:
        Exception: 下载失败
    """
    if total > 1:
        print_info(f"正在下载图片 {index}/{total}...")
    else:
        print_info("正在下载图片...")

    try:
        response = requests.get(image_url, stream=True, timeout=60)
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
                            f"\r  进度: {percent}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)",
                            end=''
                        )

        print_info("")  # 换行
        print_info(f"  已保存: {output_path.absolute()}")

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
        description="Seedream 图片生成 - 使用火山引擎 AI 模型生成图片",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  # 文本生成图片
  python3 generate_image.py --prompt "一只可爱的小猫"

  # 图片编辑
  python3 generate_image.py --prompt "将背景改为蓝天" --image "cat.jpg"

  # 多图融合
  python3 generate_image.py --prompt "将图1的服装换为图2的服装" --image img1.jpg --image img2.jpg

  # 组图生成
  python3 generate_image.py --prompt "生成四季主题插画" --sequential --max-images 4

更多信息请查看 SKILL.md
        """
    )

    # 必需参数
    parser.add_argument(
        "--prompt",
        required=True,
        help="图片描述提示词（必需）"
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
        "--size",
        default=DEFAULT_SIZE,
        choices=["1K", "2K", "4K"],
        help=f"图片尺寸（默认: {DEFAULT_SIZE}）"
    )

    parser.add_argument(
        "--no-watermark",
        action="store_true",
        help="不添加水印"
    )

    parser.add_argument(
        "--sequential",
        action="store_true",
        help="生成组图（多张关联图片）"
    )

    parser.add_argument(
        "--max-images",
        type=int,
        default=4,
        help="组图数量（默认: 4，配合 --sequential 使用）"
    )

    parser.add_argument(
        "--search",
        action="store_true",
        help="启用联网搜索（使用 Seedream 5.0 lite）"
    )

    # 可选参数 - 输出
    parser.add_argument(
        "--output",
        default="generated_image.png",
        help="输出文件路径（默认: generated_image.png）"
    )

    args = parser.parse_args()

    # 验证配置
    if not validate_config():
        sys.exit(1)

    # 验证参数
    if args.sequential and args.max_images < 1:
        print_error("max-images 必须大于 0")
        sys.exit(1)

    # 执行生成流程
    try:
        print_info("=" * 50)
        print_info("Seedream 图片生成")
        print_info("=" * 50)
        print_info("")

        # 生成图片
        result = generate_image(
            prompt=args.prompt,
            image_paths=args.image,
            model=args.model,
            size=args.size,
            watermark=not args.no_watermark,
            sequential=args.sequential,
            max_images=args.max_images,
            enable_search=args.search
        )

        # 下载图片
        data = result.get("data", [])

        if not data:
            raise Exception("API 返回格式错误：缺少 data")

        print_info("")

        # 处理单图或组图
        if len(data) == 1:
            # 单张图片
            image_url = data[0].get("url")
            if not image_url:
                raise Exception("API 返回格式错误：缺少 url")

            output_path = Path(args.output)
            download_image(image_url, output_path)

            # 输出成功信息到 stdout（供 Claude 读取）
            print_info("")
            print_info("=" * 50)
            print_info("✓ 生成成功！")
            print_info("=" * 50)

            print("图片生成成功！")
            print(f"文件路径: {output_path.absolute()}")
            print(f"尺寸: {data[0].get('size', 'N/A')}")
            if 'usage' in result:
                usage = result['usage']
                print(f"生成图片数: {usage.get('generated_images', 1)}")
                print(f"Token消耗: {usage.get('total_tokens', 'N/A')}")
        else:
            # 多张图片（组图）
            output_base = Path(args.output)
            stem = output_base.stem
            suffix = output_base.suffix
            parent = output_base.parent

            for i, img_data in enumerate(data, 1):
                image_url = img_data.get("url")
                if not image_url:
                    print_error(f"图片 {i} 缺少 URL，跳过")
                    continue

                # 生成文件名：image_1.png, image_2.png, ...
                output_path = parent / f"{stem}_{i}{suffix}"
                download_image(image_url, output_path, i, len(data))

            # 输出成功信息到 stdout
            print_info("")
            print_info("=" * 50)
            print_info("✓ 生成成功！")
            print_info("=" * 50)

            print(f"组图生成成功！共 {len(data)} 张")
            print(f"输出目录: {parent.absolute()}")
            print(f"文件命名: {stem}_1{suffix} ~ {stem}_{len(data)}{suffix}")
            if 'usage' in result:
                print(f"Token消耗: {result['usage'].get('total_tokens', 'N/A')}")

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
