#!/bin/bash
# Supervise Xvfb → fluxbox → chromium → x11vnc. A child that exits is restarted;
# tini (PID 1) reaps orphans so crashed renderers never pile up as zombies.
set -u
# Xlib tries the abstract X socket before the filesystem one, and abstract
# sockets are shared with the slot through the netns. Pick a display number the
# slot is not serving, or our clients would draw on the slot's X server.
pick_display() {
  local n
  for n in $(seq 73 199); do
    grep -q "@/tmp/.X11-unix/X$n\b" /proc/net/unix 2>/dev/null || { echo ":$n"; return; }
  done
  echo ":73"
}
DISPLAY_NUM="${KIN_DESKTOP_DISPLAY:-$(pick_display)}"
GEOMETRY="${KIN_DESKTOP_GEOMETRY:-1600x900x24}"
SOCKET="${KIN_DESKTOP_SOCKET:-/tmp/kin-desktop/vnc.sock}"
PROFILE="${HOME}/chromium"
LOG_DIR=/tmp/kin-desktop-log
export DISPLAY="$DISPLAY_NUM"
mkdir -p "$(dirname "$SOCKET")" "$LOG_DIR" "$PROFILE"
chmod 700 "$(dirname "$SOCKET")"
rm -f "$SOCKET" "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}"
# A profile copied across containers keeps Chromium's singleton lock; drop it.
rm -f "$PROFILE"/Singleton{Lock,Socket,Cookie}

supervise() {
  local name="$1"
  shift
  while true; do
    "$@" >>"$LOG_DIR/$name.log" 2>&1
    echo "$(date -u +%FT%TZ) $name exited code=$?" >>"$LOG_DIR/supervise.log"
    sleep 2
  done
}

# -nolisten local: no abstract-namespace X socket. Abstract sockets belong to the
# network namespace, which this container shares with the slot; only the
# filesystem socket in this container's private /tmp may serve the display.
supervise xvfb Xvfb "$DISPLAY_NUM" -screen 0 "$GEOMETRY" -nolisten tcp -nolisten local &
for _ in $(seq 1 100); do
  [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break
  sleep 0.1
done

supervise fluxbox fluxbox &
# The companion runs with cap-drop ALL and no-new-privileges, so Chromium's
# setuid/userns sandbox is unavailable; the container is the isolation boundary.
supervise chromium chromium --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check --start-maximized --password-store=basic \
  --user-data-dir="$PROFILE" &
supervise x11vnc x11vnc -display "$DISPLAY_NUM" -rfbport 0 -unixsock "$SOCKET" \
  -forever -shared -nopw -noxdamage -quiet &

wait
