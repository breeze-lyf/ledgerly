#!/usr/bin/env bash
set -euo pipefail
yes=0; nginx=0
for arg in "$@"; do
  case "$arg" in --yes) yes=1;; --nginx) nginx=1;; *) echo 'Usage: deploy/deploy.sh --yes [--nginx]' >&2; exit 2;; esac
done
[[ "$yes" == 1 ]] || { echo 'Require --yes to deploy' >&2; exit 2; }
: "${DEPLOY_HOST:?Set DEPLOY_HOST to <server>}"
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9_.@-]+$ ]] || exit 2
export BRIDGE="${BRIDGE:-/workspace/evs/s.py}"
export DEPLOY_HOST
cd "$(dirname "$0")/.."
npm ci
BASE_PATH=/ npm run build
archive=$(mktemp /tmp/ledgerly-release.XXXXXX.tar.gz)
trap 'rm -f "$archive"' EXIT
tar -czf "$archive" dist web/dist package.json package-lock.json deploy
# The wrapper overrides only the bridge host, retaining its existing credential loader.
python3 deploy/bridge.py put "$archive" /tmp/ledgerly-release.tar.gz
remote=$(cat <<'REMOTE'
set -eu
mkdir -p /opt/ledgerly/data
tar -xzf /tmp/ledgerly-release.tar.gz -C /opt/ledgerly
cd /opt/ledgerly
npm ci --omit=dev
# Provision .env separately; deployments never copy or overwrite it.
test -f .env
install -m 644 deploy/ledgerly.service /etc/systemd/system/ledgerly.service
systemctl daemon-reload
systemctl enable ledgerly.service
systemctl restart ledgerly.service
for attempt in 1 2 3 4 5; do
  if curl --fail --silent http://127.0.0.1:3910/api/health >/dev/null; then break; fi
  [ "$attempt" -lt 5 ] || exit 1
  sleep 2
done
if [ "$INSTALL_NGINX" = 1 ]; then
  conf=/etc/nginx/conf.d/ledgerly.conf
  backup="$conf.backup-$(date +%Y%m%d-%H%M%S)"
  if [ -e "$conf" ]; then cp -p "$conf" "$backup"; fi
  install -m 644 deploy/ledgerly.conf "$conf"
  if ! nginx -t; then
    if [ -e "$backup" ]; then cp -p "$backup" "$conf"; else rm -f "$conf"; fi
    exit 1
  fi
  systemctl reload nginx
  curl --fail --silent https://ledgerly.yufeng.fun/api/health >/dev/null
fi
rm -f /tmp/ledgerly-release.tar.gz
REMOTE
)
python3 deploy/bridge.py "INSTALL_NGINX=$nginx; $remote"
