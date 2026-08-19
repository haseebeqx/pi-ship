#!/usr/bin/env bash
set -euo pipefail

MODE=${1:?install or update is required}
NODE_VERSION=v22.22.0

if [[ $(id -u) -ne 0 ]]; then
  echo "installer must run as root" >&2
  exit 1
fi

# Updates replace shared paths and restart one service; concurrent installers would
# corrupt app.old or activate a release built from stale version state.
exec 9>/run/lock/pi-ship-install.lock
if ! flock -n 9; then
  echo "another Pi Ship install or update is already running" >&2
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

write_pi_version() {
  local version=$1
  printf '%s\n' "$version" >/opt/pi-ship/pi-version.tmp
  chmod 644 /opt/pi-ship/pi-version.tmp
  mv /opt/pi-ship/pi-version.tmp /opt/pi-ship/pi-version
}

# Materialize generic consumer data outside the workspace. The script never
# prints secret values or includes them in the systemd unit/status text.
install_runtime_profile() {
  install -d -m 750 -o root -g pi-ship /etc/pi-ship/secrets.d
  rm -f /etc/pi-ship/secrets.d/* /etc/pi-ship/runtime-config.json
  /opt/pi-ship/node/bin/node - "$1" "$2" <<'NODE'
const fs = require("fs");
const [configPath, secretsPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
const profile = config.runtime || {};
if (profile.configuration !== undefined) {
  fs.writeFileSync("/etc/pi-ship/runtime-config.json", JSON.stringify(profile.configuration) + "\n", { mode: 0o640 });
}
for (const [name, value] of Object.entries(secrets.runtime?.secretFiles || {})) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || typeof value !== "string" || value.includes("\0")) throw new Error("invalid runtime secret file");
  fs.writeFileSync(`/etc/pi-ship/secrets.d/${name}`, value, { mode: 0o640, flag: "wx" });
}
const quote = value => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const lines = ["[Service]"];
for (const path of profile.readOnlyDirectories || []) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\n\0]/.test(path)) throw new Error("invalid runtime directory");
  lines.push(`ReadOnlyPaths=${quote(path)}`);
}
for (const path of profile.readWriteDirectories || []) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\n\0]/.test(path)) throw new Error("invalid runtime directory");
  lines.push(`ReadWritePaths=${quote(path)}`);
}
const resources = profile.resources || {};
if (resources.memoryMaxBytes !== undefined) lines.push(`MemoryMax=${resources.memoryMaxBytes}`);
if (resources.cpuQuotaPercent !== undefined) lines.push(`CPUQuota=${resources.cpuQuotaPercent}%`);
if (resources.tasksMax !== undefined) lines.push(`TasksMax=${resources.tasksMax}`);
fs.mkdirSync("/etc/systemd/system/pi-ship.service.d", { recursive: true });
fs.writeFileSync("/etc/systemd/system/pi-ship.service.d/runtime.conf", lines.join("\n") + "\n", { mode: 0o644 });
NODE
  chown root:pi-ship /etc/pi-ship/runtime-config.json /etc/pi-ship/secrets.d/* 2>/dev/null || true
  chmod 640 /etc/pi-ship/runtime-config.json /etc/pi-ship/secrets.d/* 2>/dev/null || true
}

migrate_service_readiness() {
  local unit=/etc/systemd/system/pi-ship.service
  [[ -f $unit ]] || return 0
  if grep -q '^Type=simple$' "$unit"; then
    SERVICE_WAS_SIMPLE=yes
    sed -i 's/^Type=simple$/Type=notify\nNotifyAccess=all/' "$unit"
  fi
  if ! grep -q '^TimeoutStartSec=' "$unit"; then
    sed -i '/^RestartSec=/a TimeoutStartSec=60s' "$unit"
  fi
  systemctl daemon-reload
}

restore_service_readiness() {
  [[ ${SERVICE_WAS_SIMPLE:-no} == yes ]] || return 0
  local unit=/etc/systemd/system/pi-ship.service
  sed -i '/^NotifyAccess=all$/d; /^TimeoutStartSec=60s$/d; s/^Type=notify$/Type=simple/' "$unit"
  systemctl daemon-reload
}

install_pi_version() {
  local destination=$1
  local version=$2
  local package_name=@earendil-works/pi-coding-agent
  local package_root="$destination/lib/node_modules/pi-ship"
  PATH="/opt/pi-ship/node/bin:$PATH" /opt/pi-ship/node/bin/npm install \
    --prefix "$package_root" --save-exact "$package_name@$version" \
    --omit=dev --no-audit --no-fund
  local installed
  installed=$(/opt/pi-ship/node/bin/node -p 'require(process.argv[1]).version' "$package_root/node_modules/$package_name/package.json")
  if [[ $installed != "$version" ]]; then
    echo "installed Pi version $installed does not match requested version $version" >&2
    exit 1
  fi
}

if [[ $MODE == configure ]]; then
  CONFIG=${2:?config is required}
  SECRETS=${3:?secrets are required}
  [[ -x /opt/pi-ship/node/bin/node ]] || { echo "Pi Ship runtime is not installed" >&2; exit 1; }
  [[ -f /etc/pi-ship/config.json && -f /etc/pi-ship/secrets.json ]] || { echo "Pi Ship is not configured" >&2; exit 1; }

  /opt/pi-ship/node/bin/node -e '
    const [configPath, secretsPath] = process.argv.slice(1);
    const fs = require("fs");
    const config = require(configPath);
    const secrets = require(secretsPath);
    const previous = require("/etc/pi-ship/secrets.json");
    if (secrets.runtime === undefined && previous.runtime !== undefined) {
      secrets.runtime = previous.runtime;
      fs.writeFileSync(secretsPath, JSON.stringify(secrets) + "\n", { mode: 0o600 });
    }
    const count = Number(Boolean(config.telegram)) + Number(Boolean(config.slack));
    if (count > 1) throw new Error("only one messaging provider can be configured");
    if (config.telegram && !secrets.telegram?.botToken) throw new Error("Telegram bot token is missing");
    if (config.slack && (!secrets.slack?.botToken || !secrets.slack?.appToken)) throw new Error("Slack tokens are missing");
  ' "$CONFIG" "$SECRETS"

  backup=$(mktemp -d /etc/pi-ship/channel-backup.XXXXXX)
  cp -a /etc/pi-ship/config.json "$backup/config.json"
  cp -a /etc/pi-ship/secrets.json "$backup/secrets.json"
  TELEGRAM_STATE_WAS_PRESENT=no
  SLACK_STATE_WAS_PRESENT=no
  if [[ -e /var/lib/pi-ship/telegram-state.json ]]; then
    cp -a /var/lib/pi-ship/telegram-state.json "$backup/telegram-state.json"
    TELEGRAM_STATE_WAS_PRESENT=yes
  fi
  if [[ -e /var/lib/pi-ship/slack-state.json ]]; then
    cp -a /var/lib/pi-ship/slack-state.json "$backup/slack-state.json"
    SLACK_STATE_WAS_PRESENT=yes
  fi
  SERVICE_WAS_ENABLED=no
  SERVICE_WAS_ACTIVE=no
  if systemctl is-enabled --quiet pi-ship.service; then SERVICE_WAS_ENABLED=yes; fi
  if systemctl is-active --quiet pi-ship.service; then SERVICE_WAS_ACTIVE=yes; fi
  CONFIGURED=no

  rollback_configure() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ $CONFIGURED != yes ]]; then
      set +e
      systemctl stop pi-ship.service
      cp -a "$backup/config.json" /etc/pi-ship/config.json
      cp -a "$backup/secrets.json" /etc/pi-ship/secrets.json
      rm -f /var/lib/pi-ship/telegram-state.json /var/lib/pi-ship/slack-state.json
      if [[ $TELEGRAM_STATE_WAS_PRESENT == yes ]]; then cp -a "$backup/telegram-state.json" /var/lib/pi-ship/telegram-state.json; fi
      if [[ $SLACK_STATE_WAS_PRESENT == yes ]]; then cp -a "$backup/slack-state.json" /var/lib/pi-ship/slack-state.json; fi
      if [[ $SERVICE_WAS_ENABLED == yes ]]; then systemctl enable pi-ship.service; else systemctl disable pi-ship.service; fi
      if [[ $SERVICE_WAS_ACTIVE == yes ]]; then systemctl start pi-ship.service; fi
    fi
    rm -rf "$backup"
    exit "$status"
  }
  trap rollback_configure EXIT
  trap 'exit 1' HUP INT TERM

  systemctl stop pi-ship.service || true
  install -m 640 -o root -g pi-ship "$CONFIG" /etc/pi-ship/config.json
  install -m 640 -o root -g pi-ship "$SECRETS" /etc/pi-ship/secrets.json
  install_runtime_profile /etc/pi-ship/config.json /etc/pi-ship/secrets.json
  systemctl daemon-reload
  # Reconfiguring a provider intentionally revokes its previous sender allowlist.
  rm -f /var/lib/pi-ship/telegram-state.json /var/lib/pi-ship/slack-state.json
  PERSISTENT=$(/opt/pi-ship/node/bin/node -e 'const c=require(process.argv[1]); process.stdout.write(c.telegram || c.slack ? "yes" : "no")' /etc/pi-ship/config.json)
  if [[ $PERSISTENT == yes ]]; then
    systemctl enable pi-ship.service
    systemctl start pi-ship.service
  else
    systemctl disable pi-ship.service >/dev/null 2>&1 || true
  fi

  CONFIGURED=yes
  trap - EXIT HUP INT TERM
  rm -rf "$backup"
  echo "Messaging provider configuration updated"
  exit 0
fi

if [[ $MODE == update-pi ]]; then
  VERSION=${2:?Pi version is required}
  EXPECTED_VERSION=${3:?expected installed Pi version is required}
  [[ -x /opt/pi-ship/node/bin/npm ]] || { echo "Pi Ship runtime is not installed" >&2; exit 1; }
  validate_version "$VERSION"
  validate_version "$EXPECTED_VERSION"

  package_name=@earendil-works/pi-coding-agent
  package_root=/opt/pi-ship/app/lib/node_modules/pi-ship
  package_json="$package_root/node_modules/$package_name/package.json"
  [[ -f $package_json ]] || { echo "Pi is not installed in the Pi Ship runtime" >&2; exit 1; }
  INSTALLED=$(/opt/pi-ship/node/bin/node -p 'require(process.argv[1]).version' "$package_json")
  if [[ $INSTALLED != "$EXPECTED_VERSION" ]]; then
    echo "Pi version changed during update (expected $EXPECTED_VERSION, found $INSTALLED)" >&2
    exit 1
  fi

  staging=$(mktemp -d /opt/pi-ship/app.new.XXXXXX)
  old=/opt/pi-ship/app.old
  PERSISTENT=no
  SERVICE_WAS_SIMPLE=no
  ACTIVATION_STATE=none
  rollback_update_pi() {
    local status=$?
    if [[ $status -ne 0 ]]; then
      if [[ $PERSISTENT == yes && $ACTIVATION_STATE != none ]]; then systemctl stop pi-ship.service || true; fi
      if [[ $ACTIVATION_STATE == swapped ]]; then rm -rf /opt/pi-ship/app; fi
      if [[ $ACTIVATION_STATE != none && -e $old ]]; then mv "$old" /opt/pi-ship/app; fi
      restore_service_readiness
      if [[ $PERSISTENT == yes ]]; then systemctl restart pi-ship.service || true; fi
    fi
    rm -rf "$staging"
    exit "$status"
  }
  trap rollback_update_pi EXIT
  trap 'exit 1' HUP INT TERM
  cp -a /opt/pi-ship/app/. "$staging/"
  install_pi_version "$staging" "$VERSION"

  migrate_service_readiness
  PERSISTENT=$(/opt/pi-ship/node/bin/node -e 'const c=require(process.argv[1]); process.stdout.write(c.telegram || c.slack ? "yes" : "no")' /etc/pi-ship/config.json)
  if [[ $PERSISTENT == yes ]]; then
    systemctl stop pi-ship.service
  fi
  rm -rf "$old"
  mv /opt/pi-ship/app "$old"
  ACTIVATION_STATE=old-moved
  mv "$staging" /opt/pi-ship/app
  ACTIVATION_STATE=swapped

  if [[ $PERSISTENT == yes ]]; then
    if ! systemctl start pi-ship.service; then
      echo "updated Pi failed to report ready; restoring version $EXPECTED_VERSION" >&2
      false
    fi
  fi
  write_pi_version "$VERSION"
  ACTIVATION_STATE=none
  trap - EXIT HUP INT TERM
  rm -rf "$old" "$(dirname "$0")"
  echo "Pi updated successfully to $VERSION"
  exit 0
fi

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
  PERSISTENT=no
  SERVICE_WAS_SIMPLE=no
  ACTIVATION_STATE=none
  rollback_update() {
    local status=$?
    if [[ $status -ne 0 ]]; then
      if [[ $PERSISTENT == yes && $ACTIVATION_STATE != none ]]; then systemctl stop pi-ship.service || true; fi
      if [[ $ACTIVATION_STATE == swapped ]]; then rm -rf /opt/pi-ship/app; fi
      if [[ $ACTIVATION_STATE != none && -e $old ]]; then mv "$old" /opt/pi-ship/app; fi
      restore_service_readiness
      if [[ $PERSISTENT == yes ]]; then systemctl restart pi-ship.service || true; fi
    fi
    rm -rf "$staging"
    exit "$status"
  }
  trap rollback_update EXIT
  trap 'exit 1' HUP INT TERM
  install_runtime "$ARCHIVE" "$staging" "$VERSION"
  if [[ -f /opt/pi-ship/pi-version ]]; then
    PI_VERSION=$(< /opt/pi-ship/pi-version)
    validate_version "$PI_VERSION"
    install_pi_version "$staging" "$PI_VERSION"
  fi

  migrate_service_readiness
  PERSISTENT=$(/opt/pi-ship/node/bin/node -e 'const c=require(process.argv[1]); process.stdout.write(c.telegram || c.slack ? "yes" : "no")' /etc/pi-ship/config.json)
  if [[ $PERSISTENT == yes ]]; then
    systemctl stop pi-ship.service
  fi
  rm -rf "$old"
  mv /opt/pi-ship/app "$old"
  ACTIVATION_STATE=old-moved
  mv "$staging" /opt/pi-ship/app
  ACTIVATION_STATE=swapped

  if [[ $PERSISTENT == yes ]]; then
    if ! systemctl start pi-ship.service; then
      echo "updated runtime failed to report ready; restoring previous version" >&2
      false
    fi
  fi
  write_version "$VERSION"
  ACTIVATION_STATE=none
  trap - EXIT HUP INT TERM
  rm -rf "$old" "$(dirname "$ARCHIVE")"
  echo "Pi Ship updated successfully to $VERSION"
  exit 0
fi

if [[ $MODE != install ]]; then
  echo "usage: install.sh install <archive> <config> <secrets> <version> | configure <config> <secrets> | update <archive> <version> <expected-version> | update-pi <version> <expected-version>" >&2
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
PI_VERSION=$(/opt/pi-ship/node/bin/node -p "require('/opt/pi-ship/app/lib/node_modules/pi-ship/node_modules/@earendil-works/pi-coding-agent/package.json').version")
validate_version "$PI_VERSION"
write_pi_version "$PI_VERSION"

install -d -m 750 -o pi-ship -g pi-ship /etc/pi-ship
install -m 640 -o root -g pi-ship "$CONFIG" /etc/pi-ship/config.json
install -m 640 -o root -g pi-ship "$SECRETS" /etc/pi-ship/secrets.json
install_runtime_profile /etc/pi-ship/config.json /etc/pi-ship/secrets.json
install -d -m 750 -o pi-ship -g pi-ship /var/lib/pi-ship/workspace /var/lib/pi-ship/agent

cat >/etc/systemd/system/pi-ship.service <<'UNIT'
[Unit]
Description=Pi Ship persistent agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
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
TimeoutStartSec=60s
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
PERSISTENT=$(/opt/pi-ship/node/bin/node -e 'const c=require(process.argv[1]); process.exit(c.telegram || c.slack ? 0 : 1)' "$CONFIG" && echo yes || echo no)
if [[ $PERSISTENT == yes ]]; then
  systemctl enable --now pi-ship.service
  sleep 2
  systemctl is-active --quiet pi-ship.service
  echo "Pi Ship $VERSION installed with a persistent communication provider"
else
  systemctl disable --now pi-ship.service >/dev/null 2>&1 || true
  echo "Pi Ship $VERSION installed for on-demand connections"
fi
write_version "$VERSION"
rm -rf "$(dirname "$ARCHIVE")"
