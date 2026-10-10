# KVM slot runner: qemu + baked cloud image + guest assets.
#
# Base is debian:trixie-slim (qemu 10.x). Bookworm qemu 7.2 `-runas` only
# accepts a passwd name, so a per-slot numeric KIN_KVM_UID:KIN_KVM_GID
# cannot drop cleanly. Trixie's qemu 10 package dropped `-runas` entirely;
# the entrypoint drops with util-linux `setpriv --reuid --regid` instead.
# qemu 10 also has better 9p / OVMF than 7.2.
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      genisoimage \
      openssh-client \
      ovmf \
      python3 \
      qemu-system-x86 \
      qemu-utils \
      socat \
      util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/kin-kvm/guest /slot/home /slot/run /slot/kvm /opt/kin-guest/usr/local/bin /opt/kin-guest/opt/kin \
 && ls -l /usr/share/OVMF/OVMF_CODE*.fd /usr/share/OVMF/OVMF_VARS*.fd

# Fetch the cloud disk before copying scripts so entrypoint/guest edits
# do not re-download 400–700 MiB.
COPY fetch-cloud.py /usr/local/lib/kin-kvm-fetch-cloud.py
ARG CLOUD_IMAGE_URL
RUN test -n "$CLOUD_IMAGE_URL" || { echo "CLOUD_IMAGE_URL is required" >&2; exit 1; } \
 && echo "kin-kvm: fetching $CLOUD_IMAGE_URL" \
 && curl -fL --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 30 \
      -o /tmp/cloud.img "$CLOUD_IMAGE_URL" \
 && python3 /usr/local/lib/kin-kvm-fetch-cloud.py "$CLOUD_IMAGE_URL"

COPY kin-kvm-entry kin-guest-exec /usr/local/bin/
COPY guest/ /opt/kin-kvm/guest/
RUN chmod 755 /usr/local/bin/kin-kvm-entry /usr/local/bin/kin-guest-exec \
      /usr/local/lib/kin-kvm-fetch-cloud.py \
      /opt/kin-kvm/guest/kin-guest-setup \
      /opt/kin-kvm/guest/install-guest.sh \
      /opt/kin-kvm/guest/kin-kernel-start \
      /opt/kin-kvm/guest/kin-kernel-relay.py \
 && chmod 644 /opt/kin-kvm/guest/*.service /opt/kin-kvm/guest/user-data

LABEL kin.vm.runtime=kvm

ENTRYPOINT ["/usr/local/bin/kin-kvm-entry"]
