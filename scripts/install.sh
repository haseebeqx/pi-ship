#!/usr/bin/env bash
set -euo pipefail

MODE=${1:?install or update is required}
NODE_VERSION=v22.22.0

if [[ $(id -u) -ne 0 ]]; then
  echo "installer must run as root" >&2
  exit 1
fi

install_runtime() {
  local archive=$1
  local destination=$2
  local expected_version=$3
  rm -rf "$destination"
  install -d -m 755 "$destination"
  PATH="/opt/pi-ship/node/bin:$PATH" /opt/pi-ship/node/bin/npm install --global --prefix "$destination" "$archive" --omit=dev --no-audit --no-fund
  local packaged_version
  packaged_version=$(/opt/pi-ship/node/bin/node -p "require(process.argv[1]).version" "$destination/lib/node_modules/pi-ship/package.json")
  if [[ $packaged_version != "$expected_version" ]]; then
    echo "package version $packaged_version does not match requested runtime $expected_version" >&2
    exit 1
  fi
}

validate_version() {
  local version=$1
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "invalid runtime version: $version" >&2
    exit 1
  fi
}

write_version() {
  local version=$1
  printf '%s\n' "$version" >/opt/pi-ship/version.tmp
  chmod 644 /opt/pi-ship/version.tmp
  mv /opt/pi-ship/version.tmp /opt/pi-ship/version
}

if [[ $MODE == update ]]; then
  ARCHIVE=${2:?package archive is required}
  VERSION=${3:?runtime version is required}
  EXPECTED_VERSION=${4:?expected installed version is required}
  [[ -f /opt/pi-ship/version ]] || { echo "Pi Ship runtime version is not tracked" >&2; exit 1; }
  [[ -x /opt/pi-ship/node/bin/npm ]] || { echo "Pi Ship runtime is not installed" >&2; exit 1; }
  validate_version "$VERSION"
  validate_version "$EXPECTED_VERSION"
  INSTALLED=$(< /opt/pi-ship/version)
  if [[ $INSTALLED != "$EXPECTED_VERSION" ]]; then
    echo "runtime version changed during update (expected $EXPECTED_VERSION, found $INSTALLED)" >&2
    exit 1
  fi

  staging=$(mktemp -d /opt/pi-ship/app.new.XXXXXX)
  old=/opt/pi-ship/app.old
  trap 'rm -rf "$staging"' EXIT
  install_runtime "$ARCHIVE" "$staging" "$VERSION"

  systemctl stop pi-ship.service
  rm -rf "$old"
  mv /opt/pi-ship/app "$old"
  mv "$staging" /opt/pi-ship/app
  if systemctl start pi-ship.service && sleep 2 && systemctl is-active --quiet pi-ship.service; then
    write_version "$VERSION"
    rm -rf "$old" "$(dirname "$ARCHIVE")"
    echo "Pi Ship updated successfully to $VERSION"
    exit 0
  fi

  echo "updated runtime failed to start; restoring previous version" >&2
  rm -rf /opt/pi-ship/app
  mv "$old" /opt/pi-ship/app
  systemctl restart pi-ship.service
  exit 1
fi

if [[ $MODE != install ]]; then
  echo "usage: install.sh install <archive> <config> <secrets> <version> | update <archive> <version> <expected-version>" >&2
  exit 1
fi

ARCHIVE=${2:?package archive is required}
CONFIG=${3:?config is required}
SECRETS=${4:?secrets are required}
VERSION=${5:?runtime version is required}
validate_version "$VERSION"

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

install_runtime "$ARCHIVE" /opt/pi-ship/app "$VERSION"

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
write_version "$VERSION"
rm -rf "$(dirname "$ARCHIVE")"
echo "Pi Ship $VERSION installed successfully"
