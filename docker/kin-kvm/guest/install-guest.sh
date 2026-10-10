#!/bin/sh
# First boot only (cloud-init runcmd). Copies units/scripts from cidata,
# installs 9p kernel modules when the cloud image omitted them, enables
# systemd units. A single reboot is allowed if a new kernel/modules package
# was installed.
set -eu

log() { echo "kin-guest-install: $*" >&2; }
die() { echo "kin-guest-install: $*" >&2; exit 1; }

SEED=/mnt/cidata
if [ ! -f "$SEED/kin-guest-setup" ]; then
  mkdir -p /mnt/cidata
  for dev in /dev/disk/by-label/cidata /dev/sr0 /dev/cdrom; do
    [ -e "$dev" ] || continue
    mount -o ro "$dev" /mnt/cidata 2>/dev/null && break
  done
fi
[ -f "$SEED/kin-guest-setup" ] || die "cidata seed missing kin-guest-setup"

if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
fi

install_files() {
  install -m 0755 "$SEED/kin-guest-setup" /usr/local/sbin/kin-guest-setup
  install -m 0755 "$SEED/kin-kernel-start" /usr/local/sbin/kin-kernel-start
  install -m 0755 "$SEED/kin-kernel-relay.py" /usr/local/sbin/kin-kernel-relay
  install -m 0644 "$SEED/kin-guest-setup.service" /etc/systemd/system/kin-guest-setup.service
  install -m 0644 "$SEED/kin-kernel.service" /etc/systemd/system/kin-kernel.service
  install -m 0644 "$SEED/kin-kernel-relay.service" /etc/systemd/system/kin-kernel-relay.service
}

ensure_setpriv() {
  command -v setpriv >/dev/null 2>&1 && return 0
  case "${ID:-}" in
    debian|ubuntu)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y util-linux util-linux-extra || apt-get install -y util-linux
      ;;
    fedora)
      dnf install -y util-linux
      ;;
    arch)
      pacman -Sy --noconfirm util-linux
      ;;
  esac
}

ensure_python() {
  command -v python3 >/dev/null 2>&1 && return 0
  case "${ID:-}" in
    debian|ubuntu)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y python3
      ;;
    fedora)
      dnf install -y python3
      ;;
    arch)
      pacman -Sy --noconfirm python
      ;;
  esac
}

ensure_ssh_root() {
  mkdir -p /run/sshd /etc/ssh/sshd_config.d
  printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/zz-kin.conf
  if command -v sshd >/dev/null 2>&1 && ! sshd -t; then
    log "sshd -t failed; removing zz-kin.conf"
    rm -f /etc/ssh/sshd_config.d/zz-kin.conf
  fi
  systemctl enable ssh 2>/dev/null || systemctl enable sshd 2>/dev/null || true
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
}

probe_9p() {
  modprobe virtio_pci 2>/dev/null || true
  modprobe 9pnet 2>/dev/null || true
  modprobe 9pnet_virtio 2>/dev/null || true
  modprobe 9p 2>/dev/null || true
  grep -q 9p /proc/filesystems
}

install_9p_modules() {
  probe_9p && return 0
  log "9p modules missing; installing distro packages"
  case "${ID:-}" in
    debian)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      # genericcloud uses linux-image-cloud-amd64 without 9p; full amd64 image has them.
      apt-get install -y linux-image-amd64
      apt-get purge -y 'linux-image-cloud-*' || true
      update-grub 2>/dev/null || true
      return 1
      ;;
    ubuntu)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y "linux-modules-extra-$(uname -r)" || apt-get install -y linux-modules-extra-generic || true
      probe_9p && return 0
      return 1
      ;;
    fedora)
      dnf install -y kernel-modules kernel-modules-core kernel-modules-extra || true
      probe_9p && return 0
      return 1
      ;;
    arch)
      # Arch cloudimg ships the full linux package; missing 9p is unexpected.
      probe_9p && return 0
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

relax_selinux() {
  if [ -d /sys/fs/selinux ] && command -v setenforce >/dev/null 2>&1; then
    setenforce 0 2>/dev/null || true
  fi
  if [ -f /etc/selinux/config ]; then
    sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config || true
  fi
}

install_files
ensure_setpriv
ensure_python
ensure_ssh_root
relax_selinux

NEED_REBOOT=0
if ! install_9p_modules; then
  NEED_REBOOT=1
fi

systemctl daemon-reload
systemctl enable kin-guest-setup.service kin-kernel.service kin-kernel-relay.service

if [ "$NEED_REBOOT" = 1 ]; then
  if [ -f /var/lib/kin-guest-rebooted ]; then
    die "9p still missing after reboot"
  fi
  mkdir -p /var/lib
  touch /var/lib/kin-guest-rebooted
  log "rebooting once to load 9p-capable kernel/modules"
  reboot
  exit 0
fi

systemctl start kin-guest-setup.service
systemctl start kin-kernel.service
systemctl start kin-kernel-relay.service
log "units enabled"
