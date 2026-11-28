#!/usr/bin/env bash
# Deterministic dual-track builder for the Custom Debian 13 (Trixie) OS rootfs.
# Produces:
#   1. OCI image tarball / tag: kin-os-debian:13-baked (lean, kernel-free)
#   2. Read-only compressed KVM rootfs + bootable 6.12 LTS kernel/initrd:
#      kin-kvm-debian-13.erofs + vmlinuz + initrd.img
#
# Intended to run inside a debian:trixie-slim build container (or auto-delegated
# into one via --docker-wrap). Uses mmdebstrap for reproducible builds, eliminates
# glibc239/, bakes the Self-Probe-safe /etc/claude-code/managed-settings.json, and
# runs scripts/verify-os-image-secrets.mjs as a mandatory fail-closed gate.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

TARGET="both"
OUT_DIR="${REPO_ROOT}/dist/custom-debian13-os"
OCI_TAG="kin-os-debian:13-baked"
EROFS_NAME="kin-kvm-debian-13.erofs"
KERNEL_NAME="vmlinuz"
INITRD_NAME="initrd.img"
OCI_TAR_NAME="kin-os-debian-13-baked.rootfs.tar"
SUITE="trixie"
ARCH="amd64"
MIRROR="${DEBIAN_MIRROR:-http://deb.debian.org/debian}"
BUILD_IMAGE="${DEBIAN_BUILD_IMAGE:-debian:trixie-slim}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1764201600}"
DOCKER_WRAP=0
IMPORT_OCI=0
SKIP_SECRET_SCAN=0
SKIP_KERNEL=0

MANAGED_SETTINGS_SRC="${REPO_ROOT}/docker/kin-os/debian-13/managed-settings.json"
GUEST_INIT_SRC="${REPO_ROOT}/docker/kin-kvm/guest/kin-guest-init"
SLOT_AGENT_SRC="${REPO_ROOT}/docker/kin-kvm/guest/kin-slot-agent"
KERNEL_RELAY_SRC="${REPO_ROOT}/docker/kin-kvm/guest/kin-kernel-relay.py"
SSHD_CONFIG_SRC="${REPO_ROOT}/docker/kin-kvm/guest/sshd_config.kin"
SECRET_SCANNER="${REPO_ROOT}/scripts/verify-os-image-secrets.mjs"

usage() {
  cat <<'EOF'
Usage: build-custom-debian13-os.sh [options]

Options:
  --target <oci|erofs|both>    Output artifact target (default: both)
  --out-dir <dir>              Output directory (default: dist/custom-debian13-os)
  --oci-tag <tag>              OCI image tag when importing (default: kin-os-debian:13-baked)
  --erofs-name <filename>      EROFS output filename (default: kin-kvm-debian-13.erofs)
  --kernel-name <filename>     Exported kernel filename (default: vmlinuz)
  --initrd-name <filename>     Exported initrd filename (default: initrd.img)
  --arch <amd64|arm64>         Debian architecture (default: amd64)
  --mirror <url>               Debian APT mirror (default: http://deb.debian.org/debian)
  --source-date-epoch <sec>    Fixed epoch for deterministic output
  --docker-wrap                Run rootfs/EROFS build inside debian:trixie-slim container
  --import-oci                 Import OCI tarball into local docker daemon under --oci-tag
  --skip-kernel                Skip installing linux-image/initramfs-tools for EROFS target
  --help                       Show this help message
EOF
}

die() {
  printf 'build-custom-debian13-os: ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'build-custom-debian13-os: %s\n' "$*" >&2
}

import_oci_tarball() {
  local tar_path=$1
  command -v docker >/dev/null 2>&1 || die "docker CLI required for --import-oci"
  [ -f "$tar_path" ] || die "OCI tarball missing for import: $tar_path"
  log "importing OCI image -> ${OCI_TAG}"
  docker import \
    --change 'ENV LANG=en_US.UTF-8' \
    --change 'ENV LC_ALL=en_US.UTF-8' \
    --change 'ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
    --change 'LABEL kin.os.family=debian' \
    --change 'LABEL kin.os.release=13' \
    --change 'LABEL kin.os.codename=trixie' \
    --change 'LABEL kin.os.custom=debian-13-baked' \
    --change 'LABEL kin.os.glibc_unified=1' \
    --change 'LABEL org.vm2api.regular-etc-targets=1' \
    --change 'WORKDIR /home/kincli' \
    --change 'USER kincli' \
    --change 'CMD ["sleep", "infinity"]' \
    "$tar_path" "$OCI_TAG" >/dev/null
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      [ $# -ge 2 ] || die "--target requires an argument"
      TARGET="$2"
      shift 2
      ;;
    --out-dir)
      [ $# -ge 2 ] || die "--out-dir requires an argument"
      OUT_DIR="$2"
      shift 2
      ;;
    --oci-tag)
      [ $# -ge 2 ] || die "--oci-tag requires an argument"
      OCI_TAG="$2"
      shift 2
      ;;
    --erofs-name)
      [ $# -ge 2 ] || die "--erofs-name requires an argument"
      EROFS_NAME="$2"
      shift 2
      ;;
    --kernel-name)
      [ $# -ge 2 ] || die "--kernel-name requires an argument"
      KERNEL_NAME="$2"
      shift 2
      ;;
    --initrd-name)
      [ $# -ge 2 ] || die "--initrd-name requires an argument"
      INITRD_NAME="$2"
      shift 2
      ;;
    --arch)
      [ $# -ge 2 ] || die "--arch requires an argument"
      ARCH="$2"
      shift 2
      ;;
    --mirror)
      [ $# -ge 2 ] || die "--mirror requires an argument"
      MIRROR="$2"
      shift 2
      ;;
    --source-date-epoch)
      [ $# -ge 2 ] || die "--source-date-epoch requires an argument"
      SOURCE_DATE_EPOCH="$2"
      shift 2
      ;;
    --docker-wrap)
      DOCKER_WRAP=1
      shift
      ;;
    --import-oci)
      IMPORT_OCI=1
      shift
      ;;
    --skip-kernel)
      SKIP_KERNEL=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$TARGET" in
  oci|erofs|both) ;;
  *) die "invalid --target: $TARGET (expected oci, erofs, or both)" ;;
esac

case "$ARCH" in
  amd64|arm64) ;;
  *) die "invalid --arch: $ARCH (expected amd64 or arm64)" ;;
esac

[ -f "$MANAGED_SETTINGS_SRC" ] || die "missing managed-settings baseline: $MANAGED_SETTINGS_SRC"
[ -f "$SECRET_SCANNER" ] || die "missing secret scanner: $SECRET_SCANNER"
if [ "$TARGET" = "erofs" ] || [ "$TARGET" = "both" ]; then
  [ -f "$GUEST_INIT_SRC" ] || die "missing EROFS guest init: $GUEST_INIT_SRC"
  [ -f "$SLOT_AGENT_SRC" ] || die "missing EROFS slot agent: $SLOT_AGENT_SRC"
  [ -f "$KERNEL_RELAY_SRC" ] || die "missing EROFS fallback kernel relay: $KERNEL_RELAY_SRC"
  [ -f "$SSHD_CONFIG_SRC" ] || die "missing EROFS sshd config: $SSHD_CONFIG_SRC"
fi

if [ "$DOCKER_WRAP" = "1" ]; then
  command -v docker >/dev/null 2>&1 || die "docker CLI required for --docker-wrap"
  mkdir -p "$OUT_DIR"
  log "running inside ${BUILD_IMAGE} container..."
  EXTRA_FLAGS=()
  [ "$SKIP_KERNEL" = "1" ] && EXTRA_FLAGS+=(--skip-kernel)
  docker run --rm \
    --cap-add SYS_ADMIN \
    --security-opt apparmor=unconfined \
    --security-opt seccomp=unconfined \
    -v "${REPO_ROOT}:/work:ro" \
    -v "${OUT_DIR}:/out" \
    -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    -e "DEBIAN_MIRROR=${MIRROR}" \
    "${BUILD_IMAGE}" \
    bash -lc '
      set -euo pipefail
      apt-get update
      apt-get install -y --no-install-recommends mmdebstrap erofs-utils ca-certificates nodejs tar cpio zstd gzip xz-utils initramfs-tools-core
      exec bash /work/scripts/build-custom-debian13-os.sh \
        --target "'"${TARGET}"'" \
        --out-dir /out \
        --oci-tag "'"${OCI_TAG}"'" \
        --erofs-name "'"${EROFS_NAME}"'" \
        --kernel-name "'"${KERNEL_NAME}"'" \
        --initrd-name "'"${INITRD_NAME}"'" \
        --arch "'"${ARCH}"'" \
        --mirror "'"${MIRROR}"'" \
        --source-date-epoch "'"${SOURCE_DATE_EPOCH}"'" \
        '"${EXTRA_FLAGS[*]:-}"'
    '
  if [ "$IMPORT_OCI" = "1" ] && { [ "$TARGET" = "oci" ] || [ "$TARGET" = "both" ]; }; then
    import_oci_tarball "${OUT_DIR}/${OCI_TAR_NAME}"
  fi
  exit 0
fi

export SOURCE_DATE_EPOCH
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8

command -v mmdebstrap >/dev/null 2>&1 || die "mmdebstrap not found (run inside debian:trixie-slim or pass --docker-wrap)"
command -v node >/dev/null 2>&1 || die "node not found (required for verify-os-image-secrets.mjs)"
if [ "$TARGET" = "erofs" ] || [ "$TARGET" = "both" ]; then
  command -v mkfs.erofs >/dev/null 2>&1 || die "mkfs.erofs not found (install erofs-utils)"
fi

mkdir -p "$OUT_DIR"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kin-debian13-build.XXXXXX")"
ROOTFS_DIR="${WORK_DIR}/rootfs"
cleanup() {
  for mp in dev/pts dev sys proc; do
    if mountpoint -q "${ROOTFS_DIR}/${mp}" 2>/dev/null; then
      umount -l "${ROOTFS_DIR}/${mp}" 2>/dev/null || true
    fi
  done
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Dual-track shared baseline package list (must stay aligned with docker/kin-os/debian-13/Dockerfile).
BASE_PKGS="bash,bubblewrap,ca-certificates,curl,file,git,iproute2,jq,less,locales,ncurses-term,nftables,openssh-client,procps,python3,ripgrep,socat,tzdata,util-linux"

log "bootstrapping deterministic Debian 13 (${SUITE}/${ARCH}) rootfs via mmdebstrap..."
mmdebstrap \
  --variant=minbase \
  --arch="${ARCH}" \
  --components=main \
  --include="${BASE_PKGS}" \
  --mode=auto \
  --customize-hook='sed -i "s/^# *en_US\.UTF-8 UTF-8/en_US.UTF-8 UTF-8/" "$1/etc/locale.gen" && (grep -q "^en_US\.UTF-8 UTF-8" "$1/etc/locale.gen" || printf "%s\n" "en_US.UTF-8 UTF-8" >> "$1/etc/locale.gen") && chroot "$1" locale-gen en_US.UTF-8' \
  --customize-hook='chroot "$1" groupadd -g 987 kincli || true' \
  --customize-hook='chroot "$1" useradd -u 999 -g 987 -d /home/kincli -m -s /bin/bash kincli || true' \
  --customize-hook='install -d -m 0755 -o root -g root "$1/etc/claude-code" "$1/etc/claude-code/managed-settings.d" "$1/opt/kin/store" "$1/opt/kin/store/claude" "$1/opt/kin/store/crag" "$1/opt/kin/store/profiles" "$1/run/kin/bridge" "$1/usr/local/bin"' \
  --customize-hook='ln -sfn /opt/kin/store/claude/current "$1/usr/local/bin/claude"' \
  --customize-hook='rm -f "$1/etc/claude-code/CLAUDE.md" "$1/etc/machine-id" "$1/var/lib/dbus/machine-id"' \
  --customize-hook='rm -rf "$1/opt/kin/glibc239" "$1/usr/local/lib/glibc239" "$1/var/lib/apt/lists/"* "$1/var/cache/apt/archives/"* "$1/usr/share/doc/"* "$1/usr/share/man/"*' \
  "${SUITE}" \
  "${ROOTFS_DIR}" \
  "${MIRROR}"

# Install Self-Probe-safe read-only managed-settings baseline and OS identity markers.
install -m 0644 -o root -g root "$MANAGED_SETTINGS_SRC" "${ROOTFS_DIR}/etc/claude-code/managed-settings.json"
printf '%s\n' 'debian-13' > "${ROOTFS_DIR}/etc/kin-os"
printf '%s\n' 'claude-code=2.1.321' > "${ROOTFS_DIR}/etc/kin-claude"
rm -f "${ROOTFS_DIR}/etc/claude-code/CLAUDE.md"

ensure_regular_etc_targets() {
  local root=$1
  # Replace Debian symlinks (/etc/os-release, /etc/localtime) with regular 0644 placeholder files
  # so Docker :ro bind mounts and RO EROFS guest bind mounts never follow symlinks or pollute tzdata.
  if [ -e "${root}/usr/lib/os-release" ]; then
    cp -L "${root}/usr/lib/os-release" "${root}/etc/.os-release.reg"
    rm -f "${root}/etc/os-release"
    mv -f "${root}/etc/.os-release.reg" "${root}/etc/os-release"
    if [ -L "${root}/usr/lib/os-release" ]; then
      cp -L "${root}/etc/os-release" "${root}/usr/lib/.os-release.reg"
      rm -f "${root}/usr/lib/os-release"
      mv -f "${root}/usr/lib/.os-release.reg" "${root}/usr/lib/os-release"
    fi
    chmod 0644 "${root}/etc/os-release" "${root}/usr/lib/os-release"
  fi
  rm -f "${root}/etc/localtime" "${root}/etc/timezone"
  cp -L "${root}/usr/share/zoneinfo/UTC" "${root}/etc/localtime"
  printf '%s\n' 'UTC' > "${root}/etc/timezone"
  chmod 0644 "${root}/etc/localtime" "${root}/etc/timezone"
}

ensure_regular_etc_targets "$ROOTFS_DIR"

if [ "$SKIP_SECRET_SCAN" != "1" ]; then
  log "running fail-closed secret & compliance gate on staged rootfs..."
  node "$SECRET_SCANNER" --dir "$ROOTFS_DIR"
fi

if [ "$TARGET" = "oci" ] || [ "$TARGET" = "both" ]; then
  OCI_TAR="${OUT_DIR}/${OCI_TAR_NAME}"
  log "packing deterministic OCI rootfs tarball -> ${OCI_TAR}"
  tar \
    --sort=name \
    --mtime="@${SOURCE_DATE_EPOCH}" \
    --numeric-owner \
    -C "$ROOTFS_DIR" \
    -cf "$OCI_TAR" .
  node "$SECRET_SCANNER" --tar "$OCI_TAR"
  if [ "$IMPORT_OCI" = "1" ]; then
    import_oci_tarball "$OCI_TAR"
  fi
fi

if [ "$TARGET" = "erofs" ] || [ "$TARGET" = "both" ]; then
  EROFS_EXTRA_PKGS=(kmod openssh-server)
  if [ "$SKIP_KERNEL" != "1" ]; then
    EROFS_EXTRA_PKGS+=(initramfs-tools "linux-image-${ARCH}")
  fi
  log "installing EROFS KVM packages (${EROFS_EXTRA_PKGS[*]}) inside chroot..."
  # Ensure APT resolves DNS inside chroot and prevent services (e.g. sshd) from starting during package postinst.
  if [ -r /etc/resolv.conf ]; then
    cp -L /etc/resolv.conf "${ROOTFS_DIR}/etc/resolv.conf"
  fi
  cat > "${ROOTFS_DIR}/usr/sbin/policy-rc.d" <<'EOF'
#!/bin/sh
exit 101
EOF
  chmod 0755 "${ROOTFS_DIR}/usr/sbin/policy-rc.d"
  mount -t proc proc "${ROOTFS_DIR}/proc"
  mount -t sysfs sysfs "${ROOTFS_DIR}/sys"
  mount --bind /dev "${ROOTFS_DIR}/dev"
  chroot "${ROOTFS_DIR}" apt-get update
  chroot "${ROOTFS_DIR}" env DEBIAN_FRONTEND=noninteractive INITRD=Yes \
    apt-get install -y --no-install-recommends "${EROFS_EXTRA_PKGS[@]}"

  if [ "$SKIP_KERNEL" != "1" ]; then
    install -d -m 0755 -o root -g root "${ROOTFS_DIR}/etc/initramfs-tools"
    cat > "${ROOTFS_DIR}/etc/initramfs-tools/modules" <<'EOF'
virtio_pci
virtio_blk
virtio_net
virtio_console
virtio_rng
virtiofs
fuse
erofs
ext4
vsock
vmw_vsock_virtio_transport
EOF
    chroot "${ROOTFS_DIR}" update-initramfs -u -k all
  fi
  umount -l "${ROOTFS_DIR}/dev" "${ROOTFS_DIR}/sys" "${ROOTFS_DIR}/proc"
  rm -f "${ROOTFS_DIR}/usr/sbin/policy-rc.d"

  # Security redline: NEVER bake static SSH host private keys into the read-only EROFS image.
  rm -f "${ROOTFS_DIR}"/etc/ssh/ssh_host_*_key* "${ROOTFS_DIR}"/etc/ssh/ssh_host_*
  if [ -n "$(find "${ROOTFS_DIR}/etc/ssh" -maxdepth 1 -name 'ssh_host_*' -print -quit 2>/dev/null)" ]; then
    die "failed to scrub /etc/ssh/ssh_host_* from EROFS rootfs"
  fi
  install -d -m 0755 -o root -g root "${ROOTFS_DIR}/etc/ssh"
  install -m 0644 -o root -g root "$SSHD_CONFIG_SRC" "${ROOTFS_DIR}/etc/ssh/sshd_config.kin"

  if [ "$SKIP_KERNEL" != "1" ]; then
    VMLINUZ_SRC="$(ls -1 "${ROOTFS_DIR}"/boot/vmlinuz-* | sort -V | tail -n 1)"
    INITRD_SRC="$(ls -1 "${ROOTFS_DIR}"/boot/initrd.img-* | sort -V | tail -n 1)"
    [ -f "$VMLINUZ_SRC" ] || die "no /boot/vmlinuz-* found after linux-image-${ARCH} install"
    [ -f "$INITRD_SRC" ] || die "no /boot/initrd.img-* found after initramfs-tools run"
    KVER="${VMLINUZ_SRC##*/vmlinuz-}"
    MOD_ROOT="${ROOTFS_DIR}/usr/lib/modules/${KVER}"
    [ -d "$MOD_ROOT" ] || MOD_ROOT="${ROOTFS_DIR}/lib/modules/${KVER}"
    BUILTIN_FILE="${MOD_ROOT}/modules.builtin"

    KERNEL_OUT="${OUT_DIR}/${KERNEL_NAME}"
    INITRD_OUT="${OUT_DIR}/${INITRD_NAME}"
    install -m 0644 "$VMLINUZ_SRC" "$KERNEL_OUT"
    install -m 0644 "$INITRD_SRC" "$INITRD_OUT"

    log "verifying required KVM boot drivers (${KVER}) in initrd/builtin/modules..."
    INITRD_LIST_FILE="${WORK_DIR}/initrd.list"
    lsinitramfs "$INITRD_OUT" > "$INITRD_LIST_FILE"
    for mod in erofs ext4 virtio_pci virtio_blk virtiofs vsock vmw_vsock_virtio_transport virtio_console virtio_net; do
      mod_re="${mod//_/[-_]}"
      if grep -Eq "/${mod_re}\.ko(\.[a-z0-9]+)?$" "$INITRD_LIST_FILE"; then
        log "  driver ${mod}: in-initrd"
      elif [ -f "$BUILTIN_FILE" ] && grep -Eq "/${mod_re}\.ko$" "$BUILTIN_FILE"; then
        log "  driver ${mod}: kernel-builtin"
      elif [ -d "$MOD_ROOT" ] && [ -n "$(find "$MOD_ROOT" -type f -regextype posix-extended -regex ".*/${mod_re}\.ko(\.[a-z0-9]+)?$" -print -quit)" ]; then
        case "$mod" in
          erofs|virtio_blk)
            die "boot-critical driver '${mod}' found only in rootfs modules, missing from ${INITRD_OUT}"
            ;;
          *)
            log "  driver ${mod}: in-rootfs-modules"
            ;;
        esac
      else
        die "required kernel driver '${mod}' missing from ${INITRD_OUT}, ${BUILTIN_FILE}, and ${MOD_ROOT}"
      fi
    done
    log "exported kernel (${VMLINUZ_SRC##*/}) -> ${KERNEL_OUT} and verified initrd -> ${INITRD_OUT}"

    # Trim /boot kernel/initrd copies from EROFS (QEMU loads -kernel/-initrd from host; /usr/lib/modules stays).
    rm -f "${ROOTFS_DIR}"/boot/vmlinuz-* "${ROOTFS_DIR}"/boot/initrd.img-* "${ROOTFS_DIR}"/boot/System.map-* "${ROOTFS_DIR}"/boot/config-*
  fi

  rm -rf "${ROOTFS_DIR}/var/lib/apt/lists/"* "${ROOTFS_DIR}/var/cache/apt/archives/"* "${ROOTFS_DIR}/usr/share/doc/"* "${ROOTFS_DIR}/usr/share/man/"*

  # Stage lightweight PID 1 init + authenticated RPC agent + fallback TCP relay + RO EROFS mountpoints.
  install -d -m 0755 -o root -g root \
    "${ROOTFS_DIR}/usr/local/sbin" \
    "${ROOTFS_DIR}/usr/local/bin" \
    "${ROOTFS_DIR}/var/lib/kin-slot" \
    "${ROOTFS_DIR}/var/lib/dbus" \
    "${ROOTFS_DIR}/run/kin" \
    "${ROOTFS_DIR}/run/sshd" \
    "${ROOTFS_DIR}/run/vm2api-crag"
  install -d -m 0700 -o 999 -g 987 "${ROOTFS_DIR}/home/kincli/.claude"
  install -m 0755 -o root -g root "$GUEST_INIT_SRC" "${ROOTFS_DIR}/usr/local/sbin/kin-guest-init"
  install -m 0755 -o root -g root "$SLOT_AGENT_SRC" "${ROOTFS_DIR}/usr/local/sbin/kin-slot-agent"
  install -m 0755 -o root -g root "$KERNEL_RELAY_SRC" "${ROOTFS_DIR}/usr/local/sbin/kin-kernel-relay"
  # Delegate Guest OAuth/worker helper binaries to the read-only shared store (zero 9p, zero baked ELF).
  ln -sfn /opt/kin/store/bin/kin-oauth-auth "${ROOTFS_DIR}/usr/local/bin/kin-oauth-auth"
  ln -sfn /opt/kin/store/bin/kin-worker "${ROOTFS_DIR}/usr/local/bin/kin-worker"
  # Zero-byte mountpoint placeholders so read-only EROFS rootfs can bind-mount immutable machine-id, resolv.conf & hosts.
  : > "${ROOTFS_DIR}/etc/machine-id"
  : > "${ROOTFS_DIR}/var/lib/dbus/machine-id"
  rm -f "${ROOTFS_DIR}/etc/resolv.conf" "${ROOTFS_DIR}/etc/hosts"
  : > "${ROOTFS_DIR}/etc/resolv.conf"
  : > "${ROOTFS_DIR}/etc/hosts"
  chmod 0444 "${ROOTFS_DIR}/etc/machine-id" "${ROOTFS_DIR}/var/lib/dbus/machine-id"
  chmod 0644 "${ROOTFS_DIR}/etc/resolv.conf" "${ROOTFS_DIR}/etc/hosts"
  ensure_regular_etc_targets "$ROOTFS_DIR"
  for etc_reg in etc/os-release usr/lib/os-release etc/localtime etc/timezone etc/passwd etc/group etc/shadow; do
    if [ -L "${ROOTFS_DIR}/${etc_reg}" ] || [ ! -f "${ROOTFS_DIR}/${etc_reg}" ]; then
      die "EROFS mountpoint target /${etc_reg} must be a regular non-symlink file"
    fi
  done
  if [ "$SKIP_SECRET_SCAN" != "1" ]; then
    log "re-running fail-closed secret & compliance gate on EROFS rootfs..."
    node "$SECRET_SCANNER" --dir "$ROOTFS_DIR"
  fi
  EROFS_OUT="${OUT_DIR}/${EROFS_NAME}"
  log "packing deterministic KVM EROFS image -> ${EROFS_OUT}"
  mkfs.erofs \
    -zlz4hc \
    -T "${SOURCE_DATE_EPOCH}" \
    --mount-point=/ \
    "$EROFS_OUT" \
    "$ROOTFS_DIR"
fi

log "done (target=${TARGET}, out=${OUT_DIR})"
