#!/usr/bin/env bash
# Reproducible builder for the pinned Linux 6.12 LTS custom KVM guest kernel
# (vmlinuz-custom + minimal initrd.img-custom with conf/conf.d/99-kin-init).
#
# - Pins Debian Trixie linux-source-6.12 & linux-config-6.12 (6.12.118-1) with
#   fail-closed SHA-256 verification on both source tarball and base Kconfig.
# - Applies patches/kernel-6.12/0001-uts-prctl-write-once.patch with --fuzz=0.
# - Builds all required KVM/FS/VirtIO/VSOCK/Overlay/nftables drivers built-in (=y)
#   so vmlinuz-custom is 100% decoupled from EROFS /usr/lib/modules vermagic.
# - Always compiles on container-local ext4 (/tmp), never expanding source under /mnt/x.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# Pinned Debian Trixie 6.12 LTS package & artifact digests (fail-closed SSOT).
KERNEL_PKG_VER="6.12.118-1"
KERNEL_SOURCE_PKG="linux-source-6.12"
KERNEL_CONFIG_PKG="linux-config-6.12"
KERNEL_CONFIG_FILE="config.amd64_none_cloud-amd64.xz"
EXPECTED_SOURCE_TAR_SHA256="17cab14f737ae8cd261506833b1a88925777f59ee977e38a8c916909108ef131"
EXPECTED_CONFIG_XZ_SHA256="26e2a0ccefa2170194711a5192d1285bcc6dbb7ab484fa443f9612563ab47052"

PATCH_FILE="${REPO_ROOT}/patches/kernel-6.12/0001-uts-prctl-write-once.patch"
OUT_DIR="${REPO_ROOT}/dist/custom-debian13-kernel"
KERNEL_NAME="vmlinuz-custom"
INITRD_NAME="initrd.img-custom"
BUILD_IMAGE="${DEBIAN_BUILD_IMAGE:-debian:trixie-slim}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1764201600}"
JOBS=""
USE_DOCKER=1
APT_CACHE_DIR="${KIN_KERNEL_APT_CACHE:-}"

usage() {
  cat <<'EOF'
Usage: build-custom-debian13-kernel.sh [options]

Options:
  --out-dir <dir>              Output directory (default: dist/custom-debian13-kernel)
  --jobs <N>                   Parallel make jobs (default: auto from nproc)
  --source-date-epoch <sec>    Deterministic build epoch (default: 1764201600)
  --build-image <image>        Debian Trixie container image (default: debian:trixie-slim)
  --apt-cache <dir>            Optional host apt archives cache dir for --docker mode
  --no-docker                  Run directly inside an existing Debian Trixie container
  --help                       Show this help message
EOF
}

die() {
  printf 'build-custom-debian13-kernel: ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'build-custom-debian13-kernel: %s\n' "$*" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ $# -ge 2 ] || die "--out-dir requires an argument"
      OUT_DIR="$2"
      shift 2
      ;;
    --jobs)
      [ $# -ge 2 ] || die "--jobs requires an argument"
      JOBS="$2"
      shift 2
      ;;
    --source-date-epoch)
      [ $# -ge 2 ] || die "--source-date-epoch requires an argument"
      SOURCE_DATE_EPOCH="$2"
      shift 2
      ;;
    --build-image)
      [ $# -ge 2 ] || die "--build-image requires an argument"
      BUILD_IMAGE="$2"
      shift 2
      ;;
    --apt-cache)
      [ $# -ge 2 ] || die "--apt-cache requires an argument"
      APT_CACHE_DIR="$2"
      shift 2
      ;;
    --no-docker)
      USE_DOCKER=0
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

[ -f "$PATCH_FILE" ] || die "missing kernel patch: $PATCH_FILE"

if [ -z "$JOBS" ]; then
  CPUS="$(nproc 2>/dev/null || echo 4)"
  if [ "$CPUS" -gt 2 ]; then
    JOBS="$((CPUS - 2))"
  else
    JOBS="$CPUS"
  fi
fi
case "$JOBS" in
  ''|*[!0-9]*) die "invalid --jobs: $JOBS" ;;
esac
[ "$JOBS" -ge 1 ] || die "invalid --jobs: $JOBS"

if [ "$USE_DOCKER" = "1" ]; then
  command -v docker >/dev/null 2>&1 || die "docker CLI required (or run inside Debian Trixie with --no-docker)"
  mkdir -p "$OUT_DIR"
  OUT_ABS="$(cd -- "$OUT_DIR" && pwd)"
  DOCKER_ARGS=(
    run --rm
    -v "${REPO_ROOT}:/work:ro"
    -v "${OUT_ABS}:/out"
    -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
  )
  if [ -n "$APT_CACHE_DIR" ]; then
    mkdir -p "$APT_CACHE_DIR"
    CACHE_ABS="$(cd -- "$APT_CACHE_DIR" && pwd)"
    DOCKER_ARGS+=(-v "${CACHE_ABS}:/var/cache/apt/archives")
  fi
  log "building pinned ${KERNEL_SOURCE_PKG}=${KERNEL_PKG_VER} inside ${BUILD_IMAGE} (jobs=${JOBS})..."
  exec docker "${DOCKER_ARGS[@]}" "${BUILD_IMAGE}" bash -ceu '
    export DEBIAN_FRONTEND=noninteractive
    rm -f /etc/apt/apt.conf.d/docker-clean
    apt-get update -qq
    apt-get install -y --no-install-recommends \
      "'"${KERNEL_SOURCE_PKG}=${KERNEL_PKG_VER}"'" \
      "'"${KERNEL_CONFIG_PKG}=${KERNEL_PKG_VER}"'" \
      build-essential bc bison flex libelf-dev libssl-dev openssl \
      cpio kmod xz-utils zstd gzip patch rsync \
      initramfs-tools initramfs-tools-core busybox-static python3
    exec bash /work/scripts/build-custom-debian13-kernel.sh \
      --no-docker \
      --out-dir /out \
      --jobs "'"${JOBS}"'" \
      --source-date-epoch "'"${SOURCE_DATE_EPOCH}"'"
  '
fi

export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8
export SOURCE_DATE_EPOCH
export KBUILD_BUILD_TIMESTAMP="@${SOURCE_DATE_EPOCH}"
export KBUILD_BUILD_USER="debian-kernel"
export KBUILD_BUILD_HOST="lists.debian.org"

SRC_TAR="/usr/src/${KERNEL_SOURCE_PKG}.tar.xz"
CFG_XZ="/usr/src/${KERNEL_CONFIG_PKG}/${KERNEL_CONFIG_FILE}"
[ -f "$SRC_TAR" ] || die "missing kernel source tarball: $SRC_TAR"
[ -f "$CFG_XZ" ] || die "missing kernel base config: $CFG_XZ"

log "verifying pinned SHA-256 digests (fail-closed)..."
printf '%s  %s\n' "$EXPECTED_SOURCE_TAR_SHA256" "$SRC_TAR" | sha256sum -c -
printf '%s  %s\n' "$EXPECTED_CONFIG_XZ_SHA256" "$CFG_XZ" | sha256sum -c -

PATCH_SHA256="$(sha256sum "$PATCH_FILE" | awk '{print $1}')"

WORK_DIR="$(mktemp -d /tmp/kin-kernel-build.XXXXXX)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

log "extracting ${SRC_TAR} on local ext4 (${WORK_DIR})..."
tar -xf "$SRC_TAR" -C "$WORK_DIR"
SRC_DIR="${WORK_DIR}/${KERNEL_SOURCE_PKG}"
[ -d "$SRC_DIR" ] || die "extracted source directory missing: $SRC_DIR"

log "applying ${PATCH_FILE} with --fuzz=0..."
patch -d "$SRC_DIR" -p1 --fuzz=0 < "$PATCH_FILE"

log "staging base config (${KERNEL_CONFIG_FILE}) and applying built-in KVM/de-virt overlay..."
xzcat "$CFG_XZ" > "${SRC_DIR}/.config"

cd "$SRC_DIR"

# Built-in (=y) required filesystems, VirtIO, VSOCK, OverlayFS, and nftables drivers
# so vmlinuz-custom boots with zero external module dependency against any EROFS rootfs.
BUILTIN_Y_OPTS=(
  EROFS_FS
  EROFS_FS_ZIP
  EROFS_FS_XATTR
  EROFS_FS_POSIX_ACL
  EROFS_FS_SECURITY
  EXT4_FS
  TMPFS
  TMPFS_POSIX_ACL
  TMPFS_XATTR
  OVERLAY_FS
  FUSE_FS
  VIRTIO_FS
  VIRTIO
  VIRTIO_PCI
  VIRTIO_BLK
  VIRTIO_NET
  VIRTIO_CONSOLE
  HW_RANDOM
  HW_RANDOM_VIRTIO
  VSOCKETS
  VIRTIO_VSOCKETS
  VIRTIO_VSOCKETS_COMMON
  INET
  IPV6
  UNIX
  NETFILTER
  NF_TABLES
  NF_TABLES_INET
  NF_TABLES_IPV4
  NF_TABLES_IPV6
  NF_CONNTRACK
  NF_DEFRAG_IPV4
  NF_DEFRAG_IPV6
  NFT_CT
  NFT_REJECT
  NFT_REJECT_INET
  NF_NAT
  NFT_NAT
  NFT_MASQ
  NETFILTER_XTABLES
  USER_NS
  PID_NS
  NET_NS
  IPC_NS
  UTS_NS
  SECCOMP
  SECCOMP_FILTER
  SECURITY_DMESG_RESTRICT
  VETH
  TUN
  BLK_DEV_LOOP
)

for opt in "${BUILTIN_Y_OPTS[@]}"; do
  scripts/config --file .config --enable "$opt"
done

# De-virtualization & fast reproducible build hardening.
DISABLED_N_OPTS=(
  FW_CFG_SYSFS
  DEBUG_INFO
  DEBUG_INFO_BTF
  DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT
  DEBUG_INFO_DWARF4
  DEBUG_INFO_DWARF5
  MODULE_SIG
  MODULE_SIG_ALL
  LOCALVERSION_AUTO
)

for opt in "${DISABLED_N_OPTS[@]}"; do
  scripts/config --file .config --disable "$opt"
done

scripts/config --file .config --enable DEBUG_INFO_NONE
scripts/config --file .config --set-str LOCALVERSION ""
scripts/config --file .config --set-str MODULE_SIG_KEY ""
scripts/config --file .config --set-str SYSTEM_TRUSTED_KEYS ""
scripts/config --file .config --set-str SYSTEM_REVOCATION_KEYS ""

make olddefconfig >/dev/null

# Fail-closed verification of every required Kconfig symbol after dependency resolution.
log "verifying resolved .config invariants..."
for opt in "${BUILTIN_Y_OPTS[@]}"; do
  if ! grep -qx "CONFIG_${opt}=y" .config; then
    die "required built-in Kconfig symbol not set to =y after olddefconfig: CONFIG_${opt}"
  fi
done
if grep -Eq '^CONFIG_FW_CFG_SYSFS=(y|m)$' .config; then
  die "CONFIG_FW_CFG_SYSFS must be disabled to hide /sys/firmware/qemu_fw_cfg"
fi

KREL="$(make -s kernelrelease)"
log "compiling bzImage (kernelrelease=${KREL}, jobs=${JOBS})..."
make -j"$JOBS" bzImage

BZIMAGE="${SRC_DIR}/arch/x86/boot/bzImage"
[ -f "$BZIMAGE" ] || die "bzImage missing after build: $BZIMAGE"

log "building minimal initrd.img-custom with conf/conf.d/99-kin-init..."
# Stage minimal /lib/modules/${KREL} metadata and /boot/config-${KREL} so mkinitramfs runs cleanly with zero warnings.
MOD_DIR="/lib/modules/${KREL}"
rm -rf "$MOD_DIR"
mkdir -p "$MOD_DIR" /boot
[ -f "${SRC_DIR}/.config" ] && cp "${SRC_DIR}/.config" "/boot/config-${KREL}"
[ -f "${SRC_DIR}/modules.builtin" ] && cp "${SRC_DIR}/modules.builtin" "$MOD_DIR/modules.builtin"
[ -f "${SRC_DIR}/modules.builtin.modinfo" ] && cp "${SRC_DIR}/modules.builtin.modinfo" "$MOD_DIR/modules.builtin.modinfo"
[ -f "${SRC_DIR}/modules.order" ] && cp "${SRC_DIR}/modules.order" "$MOD_DIR/modules.order" || : > "$MOD_DIR/modules.order"
depmod -a "$KREL"

INITRAMFS_CONF="${WORK_DIR}/initramfs-conf"
mkdir -p "${INITRAMFS_CONF}/conf.d" "${INITRAMFS_CONF}/hooks" "${INITRAMFS_CONF}/scripts"
cat > "${INITRAMFS_CONF}/initramfs.conf" <<'EOF'
MODULES=list
BUSYBOX=y
KEYMAP=n
COMPRESS=gzip
DEVICE=
NFSROOT=auto
RUNSIZE=10%
FSTYPE=auto
RESUME=none
EOF
: > "${INITRAMFS_CONF}/modules"

# Zero-invasive initramfs-tools default init override:
# /usr/share/initramfs-tools/init sources /conf/conf.d/* right after `export init=/sbin/init`
# and before parsing /proc/cmdline, eliminating `init=/usr/local/sbin/kin-guest-init` from cmdline.
cat > "${INITRAMFS_CONF}/conf.d/99-kin-init" <<'EOF'
init=/usr/local/sbin/kin-guest-init
RESUME=none
EOF
chmod 0644 "${INITRAMFS_CONF}/conf.d/99-kin-init"

mkdir -p "$OUT_DIR"
KERNEL_OUT="${OUT_DIR}/${KERNEL_NAME}"
INITRD_OUT="${OUT_DIR}/${INITRD_NAME}"

mkinitramfs -d "$INITRAMFS_CONF" -o "$INITRD_OUT" "$KREL"
install -m 0644 "$BZIMAGE" "$KERNEL_OUT"
chmod 0644 "$INITRD_OUT"

# Fail-closed verification of initrd.img-custom contents (handles single and multi-archive cpio).
log "verifying initrd.img-custom contains conf/conf.d/99-kin-init and /init..."
INITRD_CHECK="${WORK_DIR}/initrd-check"
mkdir -p "$INITRD_CHECK"
unmkinitramfs "$INITRD_OUT" "$INITRD_CHECK"
INITRD_MAIN="$INITRD_CHECK"
[ -d "${INITRD_CHECK}/main" ] && INITRD_MAIN="${INITRD_CHECK}/main"
[ -f "${INITRD_MAIN}/init" ] || die "initrd.img-custom missing /init"
[ -f "${INITRD_MAIN}/conf/conf.d/99-kin-init" ] || die "initrd.img-custom missing conf/conf.d/99-kin-init"
grep -qx 'init=/usr/local/sbin/kin-guest-init' "${INITRD_MAIN}/conf/conf.d/99-kin-init" \
  || die "initrd.img-custom conf/conf.d/99-kin-init missing expected init= line"

KERNEL_SHA256="$(sha256sum "$KERNEL_OUT" | awk '{print $1}')"
INITRD_SHA256="$(sha256sum "$INITRD_OUT" | awk '{print $1}')"
KERNEL_BYTES="$(stat -c '%s' "$KERNEL_OUT")"
INITRD_BYTES="$(stat -c '%s' "$INITRD_OUT")"

(
  cd "$OUT_DIR"
  sha256sum "$KERNEL_NAME" "$INITRD_NAME" > SHA256SUMS
)
chmod 0644 "${OUT_DIR}/SHA256SUMS"

python3 - "$OUT_DIR/kernel-build-meta.json" \
  "$KERNEL_PKG_VER" "$KREL" "$EXPECTED_SOURCE_TAR_SHA256" "$EXPECTED_CONFIG_XZ_SHA256" \
  "$PATCH_SHA256" "$KERNEL_NAME" "$KERNEL_SHA256" "$KERNEL_BYTES" \
  "$INITRD_NAME" "$INITRD_SHA256" "$INITRD_BYTES" "$SOURCE_DATE_EPOCH" <<'PY'
import json, sys
(
    out_path, pkg_ver, krel, src_sha, cfg_sha, patch_sha,
    k_name, k_sha, k_bytes, i_name, i_sha, i_bytes, epoch
) = sys.argv[1:]
meta = {
    "schema_version": 1,
    "source_package": f"linux-source-6.12={pkg_ver}",
    "config_package": f"linux-config-6.12={pkg_ver}",
    "base_config": "config.amd64_none_cloud-amd64.xz",
    "kernel_release": krel,
    "source_date_epoch": int(epoch),
    "source_tar_sha256": src_sha,
    "base_config_sha256": cfg_sha,
    "patch_sha256": patch_sha,
    "prctl_uts_once_op": "0x564d3201",
    "initrd_default_init": "/usr/local/sbin/kin-guest-init",
    "artifacts": {
        k_name: {"sha256": k_sha, "bytes": int(k_bytes)},
        i_name: {"sha256": i_sha, "bytes": int(i_bytes)},
    },
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2)
    f.write("\n")
PY
chmod 0644 "${OUT_DIR}/kernel-build-meta.json"

log "done: ${KERNEL_OUT} (${KERNEL_BYTES} B) + ${INITRD_OUT} (${INITRD_BYTES} B)"
