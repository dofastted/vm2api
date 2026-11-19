# Slot desktop companion. vm2api starts it with `NetworkMode: container:<slot>`
# so the browser shares the slot's egress; see src/lib/vm/slot-desktop.mjs.
# Nothing listens on TCP: x11vnc serves RFB on a unix socket in /tmp and the
# control plane pipes it to the panel through `docker exec socat`.
FROM debian:12
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tini procps tzdata socat \
      xvfb x11vnc fluxbox \
      chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 987 kincli \
 && useradd -u 999 -g 987 -d /home/desktop -m -s /bin/bash desktop \
 && echo "debian-12" > /etc/kin-desktop
COPY entrypoint.sh /usr/local/bin/kin-desktop
# No wallpaper setter is installed; a no-op fbsetbg ahead of /usr/bin keeps
# fluxbox from popping an xmessage dialog over the desktop on every start.
RUN chmod 755 /usr/local/bin/kin-desktop \
 && printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/fbsetbg \
 && chmod 755 /usr/local/bin/fbsetbg
USER desktop
WORKDIR /home/desktop
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kin-desktop"]
