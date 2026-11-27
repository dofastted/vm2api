# Custom Debian 13 (Trixie, glibc 2.41) slot base image for CRAG V4.
# Unifies ABI across official claude (GLIBC_2.26), CRAG (<= GLIBC_2.34), and
# kin-kernel (GLIBC_2.39), eliminating the legacy glibc239/ private loader hack.
# Never bakes plaintext crag-v2-core, private keys, slot credentials, or CLAUDE.md.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      curl \
      file \
      git \
      iproute2 \
      jq \
      less \
      locales \
      ncurses-term \
      nftables \
      openssh-client \
      procps \
      python3 \
      ripgrep \
      socat \
      tzdata \
      util-linux \
 && sed -i 's/^# *en_US\.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
 && (grep -q '^en_US\.UTF-8 UTF-8' /etc/locale.gen || printf '%s\n' 'en_US.UTF-8 UTF-8' >> /etc/locale.gen) \
 && locale-gen en_US.UTF-8 \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
 && groupadd -g 987 kincli \
 && useradd -u 999 -g 987 -d /home/kincli -m -s /bin/bash kincli \
 && install -d -m 0755 -o root -g root \
      /etc/claude-code \
      /etc/claude-code/managed-settings.d \
      /opt/kin/store \
      /opt/kin/store/claude \
      /opt/kin/store/crag \
      /opt/kin/store/profiles \
      /run/kin/bridge \
      /usr/local/bin \
 && ln -sfn /opt/kin/store/claude/current /usr/local/bin/claude \
 && rm -f /etc/claude-code/CLAUDE.md \
 && rm -rf /opt/kin/glibc239 /usr/local/lib/glibc239 \
 && printf '%s\n' 'debian-13' > /etc/kin-os \
 && printf '%s\n' 'claude-code=2.1.321' > /etc/kin-claude

# Read-only system managed-settings baseline (Self-Probe safe whitelist only).
# Must NOT define CLAUDE_CODE_ATTRIBUTION_HEADER or CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST.
COPY --chown=root:root --chmod=0644 managed-settings.json /etc/claude-code/managed-settings.json

LABEL kin.os.family=debian \
      kin.os.release=13 \
      kin.os.codename=trixie \
      kin.os.custom=debian-13-baked \
      kin.os.glibc_unified=1

WORKDIR /home/kincli
USER kincli
CMD ["sleep", "infinity"]
