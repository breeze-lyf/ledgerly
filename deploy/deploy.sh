#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != --yes || $# != 1 ]]; then
  echo 'Usage: deploy/deploy.sh --yes (contacts the configured remote server)' >&2
  exit 2
fi
cd "$(dirname "$0")/.."
: "${NGINX_CONF:?Set NGINX_CONF to the remote nginx file containing demo.yufeng.fun 443}"
[[ "$NGINX_CONF" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Invalid NGINX_CONF'; exit 2; }
bridge=/workspace/evs/s.py
[[ -f "$bridge" ]] || { echo "Missing $bridge"; exit 1; }
npm ci
BASE_PATH=/paypal-agent/ npm run build
archive=$(mktemp /tmp/ledgerly-release.XXXXXX.tar.gz)
trap 'rm -f "$archive"' EXIT
tar -czf "$archive" dist web/dist package.json package-lock.json deploy
python3 "$bridge" put "$archive" /tmp/ledgerly-release.tar.gz
# A single-quoted heredoc preserves remote variables and excludes local secrets.
remote=$(cat <<'REMOTE'
set -eu
mkdir -p /opt/ledgerly/data
tar -xzf /tmp/ledgerly-release.tar.gz -C /opt/ledgerly
cd /opt/ledgerly
# Install build tools first if not present: python3, make, g++ (better-sqlite3).
npm_config_build_from_source=true PATH=/usr/local/bin:$PATH npm ci --omit=dev --foreground-scripts
if [ ! -e .env ]; then
  (umask 077; cp deploy/env.production.example .env)
fi
chmod 600 .env
install -m 644 deploy/ledgerly.service /etc/systemd/system/ledgerly.service
install -m 644 deploy/nginx-paypal-agent.locations /etc/nginx/ledgerly-paypal-agent.locations
python3 - "$NGINX_CONF" <<'PY'
import pathlib, re, shutil, sys, time
p = pathlib.Path(sys.argv[1])
s = p.read_text()
include = 'include /etc/nginx/ledgerly-paypal-agent.locations;'
# Preserve offsets while masking comments; balance nested location blocks.
clean = re.sub(r'#[^\n]*', lambda m: ' ' * len(m.group()), s)
blocks = []
for m in re.finditer(r'\bserver\s*\{', clean):
    depth = 1; end = m.end(); quote = None; escaped = False
    while depth and end < len(clean):
        c = clean[end]
        if escaped: escaped = False
        elif c == chr(92): escaped = True
        elif quote:
            if c == quote: quote = None
        elif c in ('"', "'"): quote = c
        else: depth += (c == '{') - (c == '}')
        end += 1
    body = clean[m.end():end-1]
    if re.search(r'\bserver_name\s+[^;]*\bdemo\.yufeng\.fun\b', body) and re.search(r'\blisten\s+[^;]*\b443\b', body):
        blocks.append((m, body))
if len(blocks) != 1:
    raise SystemExit('Expected exactly one demo.yufeng.fun 443 server block; no config changed')
m, body = blocks[0]
if include not in body:
    shutil.copy2(p, str(p) + '.ledgerly-backup-' + time.strftime('%Y%m%d-%H%M%S'))
    p.write_text(s[:m.end()] + '\n    ' + include + s[m.end():])
PY
nginx -t
systemctl daemon-reload
systemctl enable ledgerly
systemctl restart ledgerly
systemctl reload nginx
for attempt in 1 2 3 4 5; do
  if curl --fail --silent http://127.0.0.1:3910/paypal-agent/api/health; then break; fi
  [ "$attempt" -lt 5 ] || exit 1
  sleep 2
done
curl --fail --silent https://demo.yufeng.fun/paypal-agent/api/health
rm -f /tmp/ledgerly-release.tar.gz
REMOTE
)
python3 "$bridge" "export NGINX_CONF='$NGINX_CONF'; $remote"
