#!/usr/bin/env bash
set -euo pipefail

ARCHIVE=${1:?package archive is required}
CONFIG=${2:?config is required}
SECRETS=${3:?secrets are required}
NODE_VERSION=v22.22.0

if [[ $(id -u) -ne 0 ]]; then
  echo "installer must run as root" >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]] || ! grep -Eq '^ID(_LIKE)?=.*(ubuntu|debian)' /etc/os-release; then
  echo "this release supports Ubuntu and Debian servers" >&2
  exit 1
fi

case $(uname -m) in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if ! command -v curl >/dev/null || ! command -v xz >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl xz-utils
fi

install -d -m 755 /opt/pi-ship
if [[ ! -x /opt/pi-ship/node/bin/node ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  base="https://nodejs.org/dist/${NODE_VERSION}"
  file="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl --fail --silent --show-error --location "$base/$file" -o "$work/$file"
  curl --fail --silent --show-error --location "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  (cd "$work" && grep "  $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/pi-ship/node
  mkdir /opt/pi-ship/node
  tar -xJf "$work/$file" --strip-components=1 -C /opt/pi-ship/node
fi

if ! id pi-ship >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/pi-ship --shell /usr/sbin/nologin pi-ship
fi

rm -rf /opt/pi-ship/app
install -d -m 755 /opt/pi-ship/app
PATH="/opt/pi-ship/node/bin:$PATH" /opt/pi-ship/node/bin/npm install --global --prefix /opt/pi-ship/app "$ARCHIVE" --omit=dev --no-audit --no-fund

install -d -m 750 -o pi-ship -g pi-ship /etc/pi-ship
install -m 640 -o root -g pi-ship "$CONFIG" /etc/pi-ship/config.json
install -m 640 -o root -g pi-ship "$SECRETS" /etc/pi-ship/secrets.json
install -d -m 750 -o pi-ship -g pi-ship /var/lib/pi-ship/workspace /var/lib/pi-ship/agent

cat >/etc/systemd/system/pi-ship.service <<'UNIT'
[Unit]
Description=Pi Ship persistent agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi-ship
Group=pi-ship
WorkingDirectory=/var/lib/pi-ship/workspace
Environment=HOME=/var/lib/pi-ship
Environment=PATH=/opt/pi-ship/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=PI_SHIP_CONFIG=/etc/pi-ship/config.json
Environment=PI_SHIP_SECRETS=/etc/pi-ship/secrets.json
ExecStart=/opt/pi-ship/app/bin/pi-ship-runtime
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
ReadWritePaths=/var/lib/pi-ship

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now pi-ship.service
sleep 2
systemctl is-active --quiet pi-ship.service
rm -rf "$(dirname "$ARCHIVE")"
echo "Pi Ship installed successfully"
