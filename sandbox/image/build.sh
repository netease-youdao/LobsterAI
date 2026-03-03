#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/out}"
WORK_DIR="${WORK_DIR:-${ROOT_DIR}/.work}"
DOWNLOADS_DIR="${WORK_DIR}/downloads"
OVERLAY_DIR="${ROOT_DIR}/overlay"
AGENT_DIR="${ROOT_DIR}/../agent-runner"

ALPINE_MIRROR=${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}
ALPINE_BRANCH=${ALPINE_BRANCH:-v3.20}
ALPINE_VERSION=${ALPINE_VERSION:-3.20.3}
IMAGE_SIZE=${IMAGE_SIZE:-4G}
ARCHS=${ARCHS:-}
AGENT_RUNNER_BUILD=${AGENT_RUNNER_BUILD:-auto}

HOST_ARCH=$(uname -m)
case "${HOST_ARCH}" in
  x86_64) HOST_ARCH=amd64 ;;
  aarch64|arm64) HOST_ARCH=arm64 ;;
  *)
    echo "Unsupported host arch: ${HOST_ARCH}" >&2
    exit 1
    ;;
esac

if [ -z "${ARCHS}" ]; then
  ARCHS="${HOST_ARCH}"
fi

SUDO=
if [ "$(id -u)" -ne 0 ]; then
  if [ "${NO_SUDO:-}" = "1" ]; then
    SUDO=
  elif command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  else
    echo "This script needs root privileges (sudo not found). Set NO_SUDO=1 if the container grants caps." >&2
    exit 1
  fi
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar
need_cmd qemu-img
need_cmd mkfs.ext4
need_cmd parted
need_cmd partprobe
need_cmd rsync
need_cmd losetup
need_cmd mount
need_cmd umount

mkdir -p "${OUT_DIR}" "${WORK_DIR}" "${DOWNLOADS_DIR}"

# Ensure loop devices are available (needed in container environments)
setup_loop_devices() {
  # Try to load the loop module
  ${SUDO} modprobe loop 2>/dev/null || true

  # Check if loop-control exists
  if [ ! -e /dev/loop-control ]; then
    echo "Warning: /dev/loop-control not found, trying to create it..."
    ${SUDO} mknod /dev/loop-control c 10 237 2>/dev/null || true
  fi

  # Create loop devices if they don't exist
  for i in $(seq 0 7); do
    if [ ! -e "/dev/loop${i}" ]; then
      ${SUDO} mknod "/dev/loop${i}" b 7 "${i}" 2>/dev/null || true
    fi
  done
}

setup_loop_devices

cleanup_mounts() {
  local mnt="$1"
  if mountpoint -q "${mnt}/boot/efi"; then
    ${SUDO} umount "${mnt}/boot/efi"
  fi
  if mountpoint -q "${mnt}/proc"; then
    ${SUDO} umount "${mnt}/proc"
  fi
  if mountpoint -q "${mnt}/sys"; then
    ${SUDO} umount "${mnt}/sys"
  fi
  if mountpoint -q "${mnt}/dev"; then
    ${SUDO} umount "${mnt}/dev"
  fi
  if mountpoint -q "${mnt}"; then
    ${SUDO} umount "${mnt}"
  fi
}

create_rootfs() {
  exec 3>&1
  exec 1>&2

  local arch="$1"
  local alpine_arch
  case "${arch}" in
    amd64) alpine_arch=x86_64 ;;
    arm64) alpine_arch=aarch64 ;;
    *)
      echo "Unsupported target arch: ${arch}" >&2
      exit 1
      ;;
  esac

  if [ "${arch}" != "${HOST_ARCH}" ] && [ "${ALLOW_CROSS:-}" != "1" ]; then
    echo "Cross-arch build not supported by default." >&2
    echo "Build ${arch} on a ${arch} host, or set ALLOW_CROSS=1 with binfmt/qemu-user-static." >&2
    exit 1
  fi

  local tarball="alpine-minirootfs-${ALPINE_VERSION}-${alpine_arch}.tar.gz"
  local url="${ALPINE_MIRROR}/${ALPINE_BRANCH}/releases/${alpine_arch}/${tarball}"
  local dest="${DOWNLOADS_DIR}/${tarball}"

  if [ ! -f "${dest}" ]; then
    echo "Downloading ${url}"
    curl -fL "${url}" -o "${dest}"
  fi

  local rootfs="${WORK_DIR}/rootfs-${arch}"
  ${SUDO} rm -rf "${rootfs}"
  ${SUDO} mkdir -p "${rootfs}"
  ${SUDO} tar -xzf "${dest}" -C "${rootfs}"

  if [ -d "${OVERLAY_DIR}" ]; then
    ${SUDO} rsync -a "${OVERLAY_DIR}/" "${rootfs}/"
  fi

  if [ ! -d "${AGENT_DIR}" ] || [ -z "$(ls -A "${AGENT_DIR}")" ]; then
    echo "Missing agent runner sources in ${AGENT_DIR}" >&2
    exit 1
  fi

  ${SUDO} mkdir -p "${rootfs}/opt/agent-runner"
  ${SUDO} rsync -a "${AGENT_DIR}/" "${rootfs}/opt/agent-runner/"

  cat <<EOF_REPO | ${SUDO} tee "${rootfs}/etc/apk/repositories" >/dev/null
${ALPINE_MIRROR}/${ALPINE_BRANCH}/main
${ALPINE_MIRROR}/${ALPINE_BRANCH}/community
EOF_REPO

  if [ -f /etc/resolv.conf ]; then
    ${SUDO} cp /etc/resolv.conf "${rootfs}/etc/resolv.conf"
  fi

  ${SUDO} mount --bind /dev "${rootfs}/dev"
  ${SUDO} mount -t proc proc "${rootfs}/proc"
  ${SUDO} mount -t sysfs sys "${rootfs}/sys"
  trap "cleanup_mounts \"${rootfs}\"" EXIT

  ${SUDO} chroot "${rootfs}" /bin/sh -c "apk update"
  # ===========================================================================
  # 安装 Alpine 包
  # ===========================================================================
  # 基础系统包：ca-certificates openrc linux-virt util-linux e2fsprogs kmod
  # Node.js 运行时：nodejs npm
  # Shell 环境：bash (Claude CLI 需要)
  # Claude CLI 工具依赖：
  #   - ripgrep: Grep/Glob 工具需要
  #   - git: 版本控制操作
  #   - python3: 部分工具可能需要
  #   - coreutils: 提供完整的 GNU 核心工具 (cat, head, tail, etc.)
  #   - findutils: 提供 find, xargs 等
  #   - grep: GNU grep
  #   - sed: GNU sed
  #   - gawk: GNU awk
  #   - curl: 网络请求
  #   - jq: JSON 处理
  #
  # 如需添加更多依赖，请在下方 apk add 命令中追加包名
  # 可用包列表: https://pkgs.alpinelinux.org/packages
  # ===========================================================================
  ${SUDO} chroot "${rootfs}" /bin/sh -c "apk add --no-cache \
    ca-certificates \
    openrc \
    linux-virt \
    util-linux \
    e2fsprogs \
    kmod \
    mdev-conf \
    nodejs \
    npm \
    bash \
    ripgrep \
    git \
    python3 \
    py3-pip \
    coreutils \
    findutils \
    grep \
    sed \
    gawk \
    curl \
    jq \
    file \
    less \
    tree \
    tar \
    gzip \
    unzip \
    openssh-client \
  "

  # Ensure agent-runner dependencies are installed
  if [ -f "${rootfs}/opt/agent-runner/package.json" ]; then
    local npm_install_cmd="npm install --omit=dev"
    if [ -f "${rootfs}/opt/agent-runner/package-lock.json" ]; then
      npm_install_cmd="npm ci --omit=dev"
    fi
    # Always install dependencies to ensure they are up-to-date
    # AGENT_RUNNER_BUILD controls whether to run the build step:
    #   "1" or "true" = always run npm install + build
    #   "auto" = always run npm install, build only if node_modules didn't exist
    #   "0" or "false" = skip entirely
    if [ "${AGENT_RUNNER_BUILD}" = "0" ] || [ "${AGENT_RUNNER_BUILD}" = "false" ]; then
      echo "Skipping agent-runner dependency installation (AGENT_RUNNER_BUILD=${AGENT_RUNNER_BUILD})"
    elif [ "${AGENT_RUNNER_BUILD}" = "1" ] || [ "${AGENT_RUNNER_BUILD}" = "true" ]; then
      ${SUDO} chroot "${rootfs}" /bin/sh -c "cd /opt/agent-runner && ${npm_install_cmd} && npm run build --if-present"
    else
      # Default behavior (auto): always install dependencies
      ${SUDO} chroot "${rootfs}" /bin/sh -c "cd /opt/agent-runner && ${npm_install_cmd}"
    fi
  fi

  if [ -f "${rootfs}/etc/conf.d/agentd" ]; then
    local entry
    entry=$(grep -E '^AGENTD_ENTRY=' "${rootfs}/etc/conf.d/agentd" | head -n 1 | cut -d= -f2- | tr -d '\"')
    if [ -n "${entry}" ] && [ ! -f "${rootfs}${entry}" ]; then
      echo "Warning: AGENTD_ENTRY not found in rootfs: ${entry}" >&2
    fi
  fi

  # Ensure essential boot services are in the correct runlevels.
  # Keep the list minimal for fast boot — agentd needs to start quickly.
  ${SUDO} mkdir -p "${rootfs}/etc/runlevels/sysinit" "${rootfs}/etc/runlevels/boot" "${rootfs}/etc/runlevels/default"

  # sysinit: device management (provides /dev and the 'dev' virtual service)
  for svc in devfs dmesg mdev; do
    if [ -f "${rootfs}/etc/init.d/${svc}" ]; then
      ${SUDO} ln -sf "/etc/init.d/${svc}" "${rootfs}/etc/runlevels/sysinit/${svc}"
    fi
  done

  # boot: kernel modules (needed for virtio drivers)
  for svc in modules; do
    if [ -f "${rootfs}/etc/init.d/${svc}" ]; then
      ${SUDO} ln -sf "/etc/init.d/${svc}" "${rootfs}/etc/runlevels/boot/${svc}"
    fi
  done

  # default: networking (for API calls) and agentd
  for svc in networking; do
    if [ -f "${rootfs}/etc/init.d/${svc}" ]; then
      ${SUDO} ln -sf "/etc/init.d/${svc}" "${rootfs}/etc/runlevels/default/${svc}"
    fi
  done

  # Ensure agentd starts on boot.
  if [ -f "${rootfs}/etc/init.d/agentd" ]; then
    ${SUDO} chroot "${rootfs}" /bin/sh -c "rc-update add agentd default" || true
  fi
  # Ensure agentd is linked into runlevels even if rc-update isn't available.
  if [ -f "${rootfs}/etc/init.d/agentd" ]; then
    ${SUDO} ln -sf /etc/init.d/agentd "${rootfs}/etc/runlevels/default/agentd"
  fi

  cleanup_mounts "${rootfs}"
  trap - EXIT

  printf '%s\n' "${rootfs}" >&3
  exec 1>&3 3>&-
}

install_grub_cfg() {
  local mnt="$1"
  local arch="$2"
  local root_device
  local console

  if [ "${arch}" = "amd64" ]; then
    root_device=/dev/vda1
    console=ttyS0
  else
    root_device=/dev/vda2
    console=ttyAMA0
  fi

  ${SUDO} mkdir -p "${mnt}/boot/grub"
  ${SUDO} tee "${mnt}/boot/grub/grub.cfg" >/dev/null <<EOF_CFG
set default=0
set timeout=0

menuentry 'Alpine Sandbox' {
  linux /boot/vmlinuz-virt root=${root_device} modules=ext4 quiet console=${console}
  initrd /boot/initramfs-virt
}
EOF_CFG
}

install_grub_packages() {
  local mnt="$1"
  local arch="$2"
  if [ "${arch}" = "amd64" ]; then
    if ! ${SUDO} chroot "${mnt}" /bin/sh -c "apk add --no-cache grub-bios"; then
      ${SUDO} chroot "${mnt}" /bin/sh -c "apk add --no-cache grub"
    fi
  else
    ${SUDO} chroot "${mnt}" /bin/sh -c "apk add --no-cache grub-efi efibootmgr dosfstools"
  fi
}

build_image() {
  local arch="$1"
  local rootfs="$2"
  local image_raw="${WORK_DIR}/linux-${arch}.raw"
  local image_out="${OUT_DIR}/linux-${arch}.qcow2"
  local mnt="${WORK_DIR}/mnt-${arch}"
  local loop_device
  local root_part
  local esp_part

  ${SUDO} rm -f "${image_raw}" "${image_out}"
  truncate -s "${IMAGE_SIZE}" "${image_raw}"

  if [ "${arch}" = "amd64" ]; then
    ${SUDO} parted -s "${image_raw}" mklabel msdos
    ${SUDO} parted -s "${image_raw}" mkpart primary ext4 1MiB 100%
    ${SUDO} parted -s "${image_raw}" set 1 boot on
  else
    need_cmd mkfs.vfat
    ${SUDO} parted -s "${image_raw}" mklabel gpt
    ${SUDO} parted -s "${image_raw}" mkpart ESP fat32 1MiB 201MiB
    ${SUDO} parted -s "${image_raw}" set 1 esp on
    ${SUDO} parted -s "${image_raw}" mkpart primary ext4 201MiB 100%
  fi

  ${SUDO} partprobe "${image_raw}" 2>/dev/null || true

  loop_device=$(${SUDO} losetup --find --partscan --show "${image_raw}")
  trap "cleanup_mounts \"${mnt}\"; ${SUDO} losetup -d \"${loop_device}\"" EXIT

  ${SUDO} partx -a "${loop_device}" >/dev/null 2>&1 || true
  sleep 0.5

  # Try to create partition device nodes if they don't exist
  # This is needed in some container environments (e.g., podman on macOS)
  local base_loop
  base_loop=$(basename "${loop_device}")
  if [ -d "/sys/block/${base_loop}" ]; then
    for part in /sys/block/${base_loop}/${base_loop}p*; do
      [ -e "${part}" ] || continue
      local name
      name=$(basename "${part}")
      local dev="/dev/${name}"
      if [ ! -e "${dev}" ]; then
        local majmin
        majmin=$(cat "${part}/dev")
        local major=${majmin%%:*}
        local minor=${majmin##*:}
        # Try mknod, but don't fail if it doesn't work (some containers don't allow it)
        ${SUDO} mknod "${dev}" b "${major}" "${minor}" 2>/dev/null || {
          echo "Warning: Could not create ${dev} via mknod, trying alternative methods..."
        }
      fi
    done
  fi

  # If partitions still don't exist, try using losetup -P to rescan
  if ! ls "${loop_device}p"* >/dev/null 2>&1; then
    echo "Partition devices not found, trying losetup rescan..."
    ${SUDO} losetup -d "${loop_device}" 2>/dev/null || true
    sleep 0.2
    loop_device=$(${SUDO} losetup --find --partscan --show "${image_raw}")
    trap "cleanup_mounts \"${mnt}\"; ${SUDO} losetup -d \"${loop_device}\"" EXIT
    sleep 0.5
  fi

  # If still no partitions, try kpartx as last resort
  local use_kpartx=0
  if ! ls "${loop_device}p"* >/dev/null 2>&1; then
    if command -v kpartx >/dev/null 2>&1; then
      echo "Using kpartx to create partition mappings..."
      ${SUDO} kpartx -av "${loop_device}" || true
      sleep 0.5
      use_kpartx=1
    fi
  fi

  local parts=()
  # First try to find partitions via lsblk
  while IFS= read -r line; do
    parts+=("/dev/${line}")
  done < <(lsblk -ln -o NAME,TYPE "${loop_device}" 2>/dev/null | awk '$2=="part"{print $1}')

  # If no partitions found via lsblk, try direct device paths
  if [ "${#parts[@]}" -eq 0 ]; then
    # Try ${loop_device}p1, ${loop_device}p2 pattern
    for i in 1 2 3; do
      if [ -e "${loop_device}p${i}" ]; then
        parts+=("${loop_device}p${i}")
      fi
    done
  fi

  # If still no partitions, try kpartx device mapper paths
  if [ "${#parts[@]}" -eq 0 ] && [ "${use_kpartx}" = "1" ]; then
    local loop_name
    loop_name=$(basename "${loop_device}")
    for i in 1 2 3; do
      local dm_path="/dev/mapper/${loop_name}p${i}"
      if [ -e "${dm_path}" ]; then
        parts+=("${dm_path}")
      fi
    done
  fi

  if [ "${arch}" = "amd64" ]; then
    if [ "${#parts[@]}" -lt 1 ]; then
      echo "No loop partitions found for ${loop_device}" >&2
      exit 1
    fi
    root_part="${parts[0]}"
  else
    if [ "${#parts[@]}" -lt 2 ]; then
      echo "Expected 2 partitions (ESP+root) for ${loop_device}" >&2
      exit 1
    fi
    esp_part="${parts[0]}"
    root_part="${parts[1]}"
  fi

  ${SUDO} mkdir -p "${mnt}"

  if [ "${arch}" = "amd64" ]; then
    ${SUDO} mkfs.ext4 -F "${root_part}"
    ${SUDO} mount "${root_part}" "${mnt}"
  else
    ${SUDO} mkfs.vfat -F 32 "${esp_part}"
    ${SUDO} mkfs.ext4 -F "${root_part}"
    ${SUDO} mount "${root_part}" "${mnt}"
    ${SUDO} mkdir -p "${mnt}/boot/efi"
    ${SUDO} mount "${esp_part}" "${mnt}/boot/efi"
  fi

  ${SUDO} tar --numeric-owner -C "${rootfs}" -cpf - . | ${SUDO} tar -C "${mnt}" -xpf -

  ${SUDO} mount --bind /dev "${mnt}/dev"
  ${SUDO} mount -t proc proc "${mnt}/proc"
  ${SUDO} mount -t sysfs sys "${mnt}/sys"

  install_grub_packages "${mnt}" "${arch}"
  install_grub_cfg "${mnt}" "${arch}"

  if [ "${arch}" = "amd64" ]; then
    ${SUDO} chroot "${mnt}" /bin/sh -c "grub-install --target=i386-pc --boot-directory=/boot ${loop_device}"
  else
    ${SUDO} chroot "${mnt}" /bin/sh -c "grub-install --target=arm64-efi --efi-directory=/boot/efi --boot-directory=/boot --removable --no-nvram"
    # Ensure a removable EFI binary exists for firmware that doesn't load NVRAM entries.
    local boot_efi="${mnt}/boot/efi/EFI/BOOT/BOOTAA64.EFI"
    if [ ! -f "${boot_efi}" ]; then
      local grub_efi=""
      grub_efi=$(find "${mnt}/usr/lib/grub" -name 'grubaa64.efi' -o -name 'BOOTAA64.EFI' 2>/dev/null | head -n 1 || true)
      if [ -n "${grub_efi}" ]; then
        ${SUDO} mkdir -p "$(dirname "${boot_efi}")"
        ${SUDO} cp "${grub_efi}" "${boot_efi}"
      else
        ${SUDO} chroot "${mnt}" /bin/sh -c "\
          mkdir -p /boot/efi/EFI/BOOT; \
          if command -v grub-mkimage >/dev/null 2>&1; then \
            grub-mkimage -O arm64-efi -o /boot/efi/EFI/BOOT/BOOTAA64.EFI -p /boot/grub \
              part_gpt part_msdos fat ext2 normal linux configfile search search_fs_uuid; \
          fi"
      fi
    fi

    # Provide a startup.nsh so the UEFI shell boots automatically if no NVRAM entry exists.
    ${SUDO} tee "${mnt}/boot/efi/startup.nsh" >/dev/null <<'EOF_NSH'
\EFI\BOOT\BOOTAA64.EFI
EOF_NSH
  fi

  if [ "${arch}" = "arm64" ]; then
    if [ -f "${mnt}/boot/vmlinuz-virt" ]; then
      ${SUDO} cp "${mnt}/boot/vmlinuz-virt" "${OUT_DIR}/vmlinuz-virt-${arch}"
    fi
    if [ -f "${mnt}/boot/initramfs-virt" ]; then
      ${SUDO} cp "${mnt}/boot/initramfs-virt" "${OUT_DIR}/initramfs-virt-${arch}"
    fi
  fi

  cleanup_mounts "${mnt}"
  # Clean up kpartx mappings if we used them
  if [ "${use_kpartx}" = "1" ] && command -v kpartx >/dev/null 2>&1; then
    ${SUDO} kpartx -dv "${loop_device}" 2>/dev/null || true
  fi
  ${SUDO} losetup -d "${loop_device}"
  trap - EXIT
  rmdir "${mnt}"

  qemu-img convert -f raw -O qcow2 "${image_raw}" "${image_out}"
  rm -f "${image_raw}"

  echo "Built ${image_out}"
}

for arch in ${ARCHS}; do
  echo "Building sandbox image for ${arch}"
  rootfs=$(create_rootfs "${arch}")
  build_image "${arch}" "${rootfs}"
  ${SUDO} rm -rf "${rootfs}"
  echo "Done: ${OUT_DIR}/linux-${arch}.qcow2"
  echo
done
