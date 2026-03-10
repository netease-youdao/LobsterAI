#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INPUT_DIR=${INPUT_DIR:-"${ROOT_DIR}/sandbox/image/out"}
VERSION=${1:-${COWORK_SANDBOX_IMAGE_VERSION:-}}
OUTPUT_BASE=${OUTPUT_BASE:-"${ROOT_DIR}/sandbox/image/publish"}

if [ -z "${VERSION}" ]; then
  echo "Usage: $0 <version>" >&2
  echo "Or set COWORK_SANDBOX_IMAGE_VERSION" >&2
  exit 1
fi

if [ ! -d "${INPUT_DIR}" ]; then
  echo "Input directory not found: ${INPUT_DIR}" >&2
  exit 1
fi

OUT_DIR="${OUTPUT_BASE}/${VERSION}"
mkdir -p "${OUT_DIR}"

if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  HASH_CMD=(shasum -a 256)
else
  echo "Missing sha256sum or shasum" >&2
  exit 1
fi

found=0
for arch in amd64 arm64; do
  src="${INPUT_DIR}/linux-${arch}.qcow2"
  dest="${OUT_DIR}/image-linux-${arch}.qcow2"
  if [ -f "${src}" ]; then
    cp -f "${src}" "${dest}"
    found=1
  else
    echo "Warning: missing ${src}" >&2
  fi
  if [ -f "${dest}" ]; then
    "${HASH_CMD[@]}" "${dest}" > "${dest}.sha256"
  fi

  kernel_src="${INPUT_DIR}/vmlinuz-virt-${arch}"
  kernel_dest="${OUT_DIR}/vmlinuz-virt-${arch}"
  if [ -f "${kernel_src}" ]; then
    cp -f "${kernel_src}" "${kernel_dest}"
    "${HASH_CMD[@]}" "${kernel_dest}" > "${kernel_dest}.sha256"
  fi

  initrd_src="${INPUT_DIR}/initramfs-virt-${arch}"
  initrd_dest="${OUT_DIR}/initramfs-virt-${arch}"
  if [ -f "${initrd_src}" ]; then
    cp -f "${initrd_src}" "${initrd_dest}"
    "${HASH_CMD[@]}" "${initrd_dest}" > "${initrd_dest}.sha256"
  fi
done

if [ "${found}" -eq 0 ]; then
  echo "No qcow2 images found in ${INPUT_DIR}" >&2
  exit 1
fi

(
  cd "${OUT_DIR}"
  if ls image-linux-*.qcow2 vmlinuz-virt-* initramfs-virt-* >/dev/null 2>&1; then
    "${HASH_CMD[@]}" image-linux-*.qcow2 vmlinuz-virt-* initramfs-virt-* > SHA256SUMS
  fi
)

cat <<EOF
Publish directory: ${OUT_DIR}

Expected CDN layout:
  ${OUT_DIR}/image-linux-amd64.qcow2
  ${OUT_DIR}/image-linux-arm64.qcow2

Environment variables:
  COWORK_SANDBOX_BASE_URL=<https://your.cdn/cowork/sandbox>
  COWORK_SANDBOX_IMAGE_VERSION=${VERSION}

Next:
  python scripts/upload-sandbox-image.py --arch all --version ${VERSION}
EOF
