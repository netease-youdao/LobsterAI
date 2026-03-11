#!/usr/bin/env python3
"""
Upload sandbox VM images to Luna NOS CDN.

Usage:
    python scripts/upload-sandbox-image.py [--arch amd64|arm64|all] [--input-dir PATH] [--version vX.Y.Z]

This script:
1. Reads the built qcow2 images from sandbox/image/out/
2. Uploads them to Luna NOS CDN
3. Prints release-ready snippets (version/url/sha256)
4. Optionally writes a versioned upload manifest under sandbox/image/publish/<version>/
"""

import os
import sys
import hashlib
import argparse
import json
from datetime import datetime, timezone
import requests

LUNA_NOS_URL = os.environ.get("LUNA_NOS_URL", "")
LUNA_NOS_PRODUCT = os.environ.get("LUNA_NOS_PRODUCT", "")
LUNA_NOS_SUCCESS_CODE = 0

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
DEFAULT_INPUT_DIR = os.path.join(ROOT_DIR, "sandbox", "image", "out")
DEFAULT_PUBLISH_BASE = os.path.join(ROOT_DIR, "sandbox", "image", "publish")
DEFAULT_VERSION = os.environ.get("COWORK_SANDBOX_IMAGE_VERSION", "")


def sha256_file(file_path: str) -> str:
    """Calculate SHA256 hash of a file."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def upload_file(file_path: str) -> str | None:
    """Upload a file to Luna NOS and return the CDN URL."""
    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    # Determine MIME type
    if file_name.endswith(".qcow2"):
        media_type = "application/octet-stream"
    elif file_name.endswith(".gz"):
        media_type = "application/gzip"
    else:
        media_type = "application/octet-stream"

    print(f"  Uploading {file_name} ({file_size:,} bytes)...")

    with open(file_path, "rb") as f:
        files = {"file": (file_name, f, media_type)}
        data = {"product": LUNA_NOS_PRODUCT, "useHttps": "true"}

        try:
            response = requests.post(LUNA_NOS_URL, files=files, data=data, timeout=600)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"  ERROR: Upload failed: {e}")
            return None

    result = response.json()
    if result.get("code") == LUNA_NOS_SUCCESS_CODE:
        url = result.get("data", {}).get("url")
        if url:
            print(f"  OK: {url}")
            return url
        else:
            print(f"  ERROR: No URL in response: {result}")
            return None
    else:
        print(f"  ERROR: Upload failed (code={result.get('code')}): {result.get('msg')}")
        return None


def write_manifest(version: str, publish_base: str, arch_results: dict[str, dict[str, str]]) -> str:
    """Write upload manifest to sandbox/image/publish/<version>/upload-manifest.json."""
    release_dir = os.path.join(publish_base, version)
    os.makedirs(release_dir, exist_ok=True)
    manifest_path = os.path.join(release_dir, "upload-manifest.json")
    payload = {
        "version": version,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "images": {
            arch: {
                "url": info["url"],
                "sha256": info["sha256"],
                "fileName": f"image-linux-{arch}.qcow2",
            }
            for arch, info in sorted(arch_results.items())
        },
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return manifest_path


def main():
    parser = argparse.ArgumentParser(description="Upload sandbox VM images to CDN")
    parser.add_argument(
        "--arch",
        choices=["amd64", "arm64", "all"],
        default="all",
        help="Architecture to upload (default: all)",
    )
    parser.add_argument(
        "--input-dir",
        default=DEFAULT_INPUT_DIR,
        help=f"Input directory (default: {DEFAULT_INPUT_DIR})",
    )
    parser.add_argument(
        "--version",
        default=DEFAULT_VERSION,
        help="Release version (example: v0.1.5). "
             "If provided, a manifest will be written to sandbox/image/publish/<version>/upload-manifest.json.",
    )
    parser.add_argument(
        "--publish-base",
        default=DEFAULT_PUBLISH_BASE,
        help=f"Base directory for release manifests (default: {DEFAULT_PUBLISH_BASE})",
    )
    args = parser.parse_args()

    if not LUNA_NOS_URL or not LUNA_NOS_PRODUCT:
        print("Error: Environment variables LUNA_NOS_URL and LUNA_NOS_PRODUCT must be set.")
        print("Example:")
        print('  set LUNA_NOS_URL=https://your-upload-endpoint/upload')
        print('  set LUNA_NOS_PRODUCT=your-product-name')
        sys.exit(1)

    input_dir = args.input_dir
    if not os.path.isdir(input_dir):
        print(f"Error: Input directory not found: {input_dir}")
        print("Run the build first: scripts\\build-sandbox-image.bat")
        sys.exit(1)

    archs = ["amd64", "arm64"] if args.arch == "all" else [args.arch]
    results = {}

    print("=" * 60)
    print("  Upload sandbox VM images to CDN")
    print("=" * 60)
    print()

    for arch in archs:
        qcow2_path = os.path.join(input_dir, f"linux-{arch}.qcow2")
        if not os.path.isfile(qcow2_path):
            print(f"[{arch}] Skipped: {qcow2_path} not found")
            continue

        file_hash = sha256_file(qcow2_path)
        print(f"[{arch}] File: {qcow2_path}")
        print(f"[{arch}] SHA256: {file_hash}")

        url = upload_file(qcow2_path)
        if url:
            results[arch] = {"url": url, "sha256": file_hash}
        else:
            print(f"[{arch}] FAILED to upload")

        print()

    if not results:
        print("No images were uploaded successfully.")
        sys.exit(1)

    # Print summary with code to update
    print("=" * 60)
    print("  Upload Summary")
    print("=" * 60)
    print()

    for arch, info in results.items():
        print(f"  {arch}:")
        print(f"    URL:    {info['url']}")
        print(f"    SHA256: {info['sha256']}")
        print()

    manifest_path = None
    version = args.version.strip()
    if version:
        manifest_path = write_manifest(version, args.publish_base, results)
        print(f"Manifest written: {manifest_path}")
        print()

    print("-" * 60)
    print("  TypeScript snippet (src/main/libs/coworkSandboxRuntime.ts):")
    print("-" * 60)
    print()
    if version:
        print(f"const SANDBOX_IMAGE_VERSION = process.env.COWORK_SANDBOX_IMAGE_VERSION || '{version}';")
    if "arm64" in results:
        print(f"const DEFAULT_SANDBOX_IMAGE_URL_ARM64 = '{results['arm64']['url']}';")
    if "amd64" in results:
        print(f"const DEFAULT_SANDBOX_IMAGE_URL_AMD64 = '{results['amd64']['url']}';")
    print()

    print("-" * 60)
    print("  Environment overrides (optional):")
    print("-" * 60)
    print()
    if version:
        print(f"COWORK_SANDBOX_IMAGE_VERSION={version}")
    if "arm64" in results:
        print(f"COWORK_SANDBOX_IMAGE_URL_ARM64={results['arm64']['url']}")
        print(f"COWORK_SANDBOX_IMAGE_SHA256_ARM64={results['arm64']['sha256']}")
    if "amd64" in results:
        print(f"COWORK_SANDBOX_IMAGE_URL_AMD64={results['amd64']['url']}")
        print(f"COWORK_SANDBOX_IMAGE_SHA256_AMD64={results['amd64']['sha256']}")

    print()
    print("Done!")


if __name__ == "__main__":
    main()
