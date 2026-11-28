import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATCH_PATH = path.join(REPO_ROOT, 'patches', 'kernel-6.12', '0001-uts-prctl-write-once.patch')
const BUILDER_PATH = path.join(REPO_ROOT, 'scripts', 'build-custom-debian13-kernel.sh')
const GUEST_INIT_PATH = path.join(REPO_ROOT, 'docker', 'kin-kvm', 'guest', 'kin-guest-init')

const unixTest = process.platform === 'win32' ? test.skip : test

test('kernel 6.12 UTS prctl patch matches kin-guest-init ABI and enforces validate-before-seal security order', () => {
  const patch = fs.readFileSync(PATCH_PATH, 'utf8')
  const guestInit = fs.readFileSync(GUEST_INIT_PATH, 'utf8')

  assert.equal(patch.includes('\r\n'), false, 'patch file must use LF line endings')

  // Must patch ONLY the 4 scoped kernel files and NEVER alter sysctl 0444 permissions.
  const touchedFiles = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1])
  assert.deepEqual(touchedFiles, [
    'include/uapi/linux/prctl.h',
    'include/linux/utsname.h',
    'fs/proc/version.c',
    'kernel/sys.c',
  ])
  assert.doesNotMatch(patch, /utsname_sysctl\.c/)

  // ABI alignment with kin-guest-init (0x564d3201, struct.pack("65s65s192s", ...), 322 bytes).
  assert.match(guestInit, /PR_KIN_SET_UTS_ONCE\s*=\s*0x564d3201/)
  assert.match(guestInit, /struct\.pack\("65s65s192s"/)
  assert.match(patch, /\+#define PR_KIN_SET_UTS_ONCE\s+0x564d3201/)
  assert.match(patch, /\+#define KIN_PROC_VERSION_MID_LEN\s+192/)
  assert.match(patch, /\+struct kin_uts_override\s*\{/)
  assert.match(patch, /\+\tchar release\[__NEW_UTS_LEN \+ 1\];/)
  assert.match(patch, /\+\tchar version\[__NEW_UTS_LEN \+ 1\];/)
  assert.match(patch, /\+\tchar proc_mid\[KIN_PROC_VERSION_MID_LEN\];/)
  assert.match(patch, /\+\tBUILD_BUG_ON\(sizeof\(req\) != 322\);/)

  // /proc/version must read under uts_sem and fall back to linux_proc_banner when unset.
  assert.match(patch, /\+\tdown_read\(&uts_sem\);/)
  assert.match(patch, /\+\tif \(kin_proc_version_mid\[0\]\)/)
  assert.match(patch, /\+\t\tseq_printf\(m, linux_proc_banner,/)
  assert.match(patch, /\+\tup_read\(&uts_sem\);/)

  // Strict 6-step security validation order inside prctl_kin_set_uts_once.
  const fnStart = patch.indexOf('+static long prctl_kin_set_uts_once(')
  assert.ok(fnStart >= 0, 'missing prctl_kin_set_uts_once helper')
  const fnBody = patch.slice(fnStart, patch.indexOf('+SYSCALL_DEFINE5(prctl', fnStart))
  assert.ok(fnBody.length > 0, 'failed to slice prctl_kin_set_uts_once body')

  const orderedChecks = [
    ['unused args == 0', 'if (arg3 || arg4 || arg5)'],
    ['CAP_SYS_ADMIN + GLOBAL_ROOT_UID', '!capable(CAP_SYS_ADMIN) || !uid_eq(current_euid(), GLOBAL_ROOT_UID)'],
    ['init_uts_ns check', 'current->nsproxy->uts_ns != &init_uts_ns'],
    ['init_pid_ns check', 'task_active_pid_ns(current) != &init_pid_ns'],
    ['fast-path sealed check', 'if (atomic_read(&kin_uts_sealed))'],
    ['copy_from_user', 'copy_from_user(&req, (const void __user *)arg2, sizeof(req))'],
    ['validate release 1..64', 'kin_valid_uts_ascii(req.release, sizeof(req.release), 1)'],
    ['validate version 1..64', 'kin_valid_uts_ascii(req.version, sizeof(req.version), 1)'],
    ['validate proc_mid 0..191', 'kin_valid_uts_ascii(req.proc_mid, sizeof(req.proc_mid), 0)'],
    ['acquire uts_sem write lock', 'down_write(&uts_sem);'],
    ['atomic write-once seal', 'if (atomic_cmpxchg(&kin_uts_sealed, 0, 1) != 0)'],
    ['zero-clear release tail bytes', 'memset(init_uts_ns.name.release, 0, sizeof(init_uts_ns.name.release));'],
    ['write release', 'strscpy(init_uts_ns.name.release, req.release, sizeof(init_uts_ns.name.release));'],
    ['zero-clear version tail bytes', 'memset(init_uts_ns.name.version, 0, sizeof(init_uts_ns.name.version));'],
    ['write version', 'strscpy(init_uts_ns.name.version, req.version, sizeof(init_uts_ns.name.version));'],
    ['release uts_sem write lock', 'up_write(&uts_sem);'],
    ['notify osrelease sysctl', 'uts_proc_notify(UTS_PROC_OSRELEASE);'],
    ['notify version sysctl', 'uts_proc_notify(UTS_PROC_VERSION);'],
  ]

  let cursor = -1
  for (const [label, needle] of orderedChecks) {
    const pos = fnBody.indexOf(needle, cursor + 1)
    assert.ok(pos > cursor, `expected '${label}' (${needle}) in strict order (pos=${pos}, prev=${cursor})`)
    cursor = pos
  }

  // Printable ASCII bounds 0x20..0x7e enforced.
  assert.match(patch, /if \(c < 0x20 \|\| c > 0x7e\)/)
  assert.match(patch, /\+\tcase PR_KIN_SET_UTS_ONCE:/)
})

test('build-custom-debian13-kernel.sh pins 6.12.118-1 digests, enforces zero-fuzz patch, built-in KVM Kconfig, and 99-kin-init', () => {
  const script = fs.readFileSync(BUILDER_PATH, 'utf8')
  assert.equal(script.includes('\r\n'), false, 'builder script must use LF line endings')

  // Pinned version & SHA-256 verification.
  assert.match(script, /KERNEL_PKG_VER="6\.12\.118-1"/)
  assert.match(script, /EXPECTED_SOURCE_TAR_SHA256="17cab14f737ae8cd261506833b1a88925777f59ee977e38a8c916909108ef131"/)
  assert.match(script, /EXPECTED_CONFIG_XZ_SHA256="26e2a0ccefa2170194711a5192d1285bcc6dbb7ab484fa443f9612563ab47052"/)
  assert.match(script, /sha256sum -c -/)
  assert.match(script, /patch -d "\$SRC_DIR" -p1 --fuzz=0/)
  assert.match(script, /mktemp -d \/tmp\/kin-kernel-build\.XXXXXX/)

  // Required built-in (=y) drivers & hardening flags.
  for (const sym of [
    'EROFS_FS',
    'EROFS_FS_ZIP',
    'EXT4_FS',
    'TMPFS',
    'OVERLAY_FS',
    'FUSE_FS',
    'VIRTIO_FS',
    'VIRTIO_PCI',
    'VIRTIO_BLK',
    'VIRTIO_NET',
    'VIRTIO_CONSOLE',
    'HW_RANDOM_VIRTIO',
    'VSOCKETS',
    'VIRTIO_VSOCKETS',
    'INET',
    'IPV6',
    'UNIX',
    'NETFILTER',
    'NF_TABLES',
    'NF_TABLES_INET',
    'NF_TABLES_IPV4',
    'NF_TABLES_IPV6',
    'NF_CONNTRACK',
    'NFT_CT',
    'NFT_REJECT',
    'NFT_REJECT_INET',
    'NF_NAT',
    'NFT_NAT',
    'NFT_MASQ',
    'NETFILTER_XTABLES',
    'SECURITY_DMESG_RESTRICT',
  ]) {
    assert.match(script, new RegExp(`\\b${sym}\\b`), `missing required built-in Kconfig symbol ${sym}`)
  }

  for (const disabled of ['FW_CFG_SYSFS', 'DEBUG_INFO', 'DEBUG_INFO_BTF', 'MODULE_SIG']) {
    assert.match(script, new RegExp(`\\b${disabled}\\b`), `missing disabled Kconfig symbol ${disabled}`)
  }
  assert.match(script, /SYSTEM_TRUSTED_KEYS ""/)
  assert.match(script, /SYSTEM_REVOCATION_KEYS ""/)
  assert.match(script, /grep -Eq '\^CONFIG_FW_CFG_SYSFS=\(y\|m\)\$' \.config/)

  // Minimal initrd.img-custom conf/conf.d/99-kin-init hook + fail-closed verification.
  assert.match(script, /conf\.d\/99-kin-init/)
  assert.match(script, /init=\/usr\/local\/sbin\/kin-guest-init/)
  assert.match(script, /unmkinitramfs "\$INITRD_OUT" "\$INITRD_CHECK"/)
  assert.match(script, /kernel-build-meta\.json/)
  assert.match(script, /SHA256SUMS/)
})

unixTest('build-custom-debian13-kernel.sh passes bash -n and --help', () => {
  const syntax = spawnSync('/bin/bash', ['-n', BUILDER_PATH], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`)

  const help = spawnSync('/bin/bash', [BUILDER_PATH, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, `--help failed: ${help.stderr}`)
  assert.match(help.stdout, /--out-dir/)
  assert.match(help.stdout, /--no-docker/)
})
