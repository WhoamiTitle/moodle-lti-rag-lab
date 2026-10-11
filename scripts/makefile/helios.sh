#!/bin/bash
# Private FreeBSD runtime and fixed HTTPS gateway for the educational Helios account.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$#" -ne 1 ]]; then
  printf '%s\n' 'Usage: helios.sh prepare|upload|publish|start|status|stop' >&2
  exit 2
fi
cd -- "$repository_root"
helios_target='s507353@helios.cs.ifmo.ru'
helios_private='/home/studs/s507353/.moodle-lti-rag'
helios_public='/home/studs/s507353/public_html/moodle-lti-rag'
ssh_options=(-i "${HELIOS_SSH_KEY:-$HOME/.ssh/helios_ed25519}" -o IdentitiesOnly=yes
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15)
if [[ -n "${HELIOS_SSH_CONTROL_PATH:-}" ]]; then
  ssh_options+=(-o "ControlPath=$HELIOS_SSH_CONTROL_PATH")
fi

remote() { ssh "${ssh_options[@]}" -p 2222 "$helios_target" "$@"; }
upload() { scp "${ssh_options[@]}" -P 2222 "$@"; }

case "${1:-}" in
  prepare)
    remote sh -s << 'REMOTE'
set -eu
umask 077
mkdir -p /home/studs/s507353/.moodle-lti-rag/runtime /home/studs/s507353/.moodle-lti-rag/packages
REMOTE
    upload deploy/helios/freebsd-packages.txt "$helios_target:$helios_private/packages/manifest.txt"
    remote sh -s << 'REMOTE'
set -eu
umask 077
root=/home/studs/s507353/.moodle-lti-rag
while IFS= read -r package; do
  case "$package" in ''|'#'*) continue ;; All/Hashed/*.pkg) ;; *) exit 1 ;; esac
  archive="$root/packages/${package##*/}"
  if ! test -f "$archive"; then
    curl --fail --silent --show-error --max-time 90 "https://pkg.FreeBSD.org/FreeBSD:14:amd64/latest/$package" -o "$archive.partial"
    mv "$archive.partial" "$archive"
  fi
  tar -xf "$archive" -C "$root/runtime" --strip-components 3 --include '/usr/local/*'
done < "$root/packages/manifest.txt"
export LD_LIBRARY_PATH="$root/runtime/lib"
"$root/runtime/bin/node" --version
"$root/runtime/bin/mongod" --version
REMOTE
    ;;
  upload)
    # Deliberate allowlist: no local env, data, keys, test platform or node_modules.
    tar -cf - package.json package-lock.json src public | remote \
      'set -eu; umask 077; mkdir -p /home/studs/s507353/.moodle-lti-rag/app; tar -xf - -C /home/studs/s507353/.moodle-lti-rag/app'
    upload .env.helios.example "$helios_target:$helios_private/env.example"
    remote sh -s << 'REMOTE'
set -eu
umask 077
root=/home/studs/s507353/.moodle-lti-rag
if ! test -e "$root/.env" && ! test -L "$root/.env"; then
  install -m 600 "$root/env.example" "$root/.env"
fi
cd "$root/app"
export LD_LIBRARY_PATH="$root/runtime/lib"
"$root/runtime/bin/node" "$root/runtime/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --ignore-scripts --no-audit --no-fund
REMOTE
    ;;
  publish)
    remote mkdir -p "$helios_public"
    upload deploy/helios/public/index.php deploy/helios/public/.htaccess "$helios_target:$helios_public/"
    remote chmod 755 "$helios_public"
    remote chmod 644 "$helios_public/index.php" "$helios_public/.htaccess"
    ;;
  start)
    remote sh -s << 'REMOTE'
set -eu
umask 077
root=/home/studs/s507353/.moodle-lti-rag
export LD_LIBRARY_PATH="$root/runtime/lib"
mkdir -p "$root/run" "$root/logs" "$root/data/mongo" "$root/data/attempts"
if test -f "$root/run/node-supervisor.pid" && kill -0 "$(cat "$root/run/node-supervisor.pid")" 2>/dev/null; then
  printf '%s\n' 'Node supervisor already running; use status or stop first.' >&2
  exit 1
fi
if ! test -f "$root/run/mongo.pid" || ! kill -0 "$(cat "$root/run/mongo.pid")" 2>/dev/null; then
  "$root/runtime/bin/mongod" --bind_ip "$root/run/mongo.sock" --port 30355 \
    --unixSocketPrefix "$root/run" --filePermissions 0700 --dbpath "$root/data/mongo" \
    --wiredTigerCacheSizeGB 0.25 --logpath "$root/logs/mongo.log" --logappend \
    --pidfilepath "$root/run/mongo.pid" --fork
fi
cd "$root/app"
/usr/sbin/daemon -f -r -R 5 -t moodle-lti-rag-node \
  -P "$root/run/node-supervisor.pid" -p "$root/run/node.pid" -o "$root/logs/node.log" \
  "$root/runtime/bin/node" --env-file="$root/.env" src/server.mjs
REMOTE
    ;;
  status)
    remote sh -s << 'REMOTE'
set -eu
root=/home/studs/s507353/.moodle-lti-rag
for name in mongo node-supervisor node; do
  if test -f "$root/run/$name.pid"; then
    process_id=$(cat "$root/run/$name.pid")
    printf '%s: ' "$name"
    ps -p "$process_id" -o pid= -o user= -o comm= || true
  fi
done
sockstat -u -l | awk '/s507353/ && /mongo.sock/ {print}'
sockstat -4 -6 -l | awk '/s507353/ && /:(30353|30355)( |$)/ {print}'
curl --silent --show-error --max-time 5 http://127.0.0.1:30353/~s507353/moodle-lti-rag/healthz
REMOTE
    ;;
  stop)
    remote sh -s << 'REMOTE'
set -eu
root=/home/studs/s507353/.moodle-lti-rag
for name in node-supervisor mongo; do
  if test -f "$root/run/$name.pid"; then
    process_id=$(cat "$root/run/$name.pid")
    case "$process_id" in ''|*[!0-9]*) exit 1 ;; esac
    if kill -0 "$process_id" 2>/dev/null; then
      test "$(ps -p "$process_id" -o user= | tr -d ' ')" = s507353
      command=$(ps -p "$process_id" -o command=)
      case "$command" in *moodle-lti-rag-node*|*"$root/runtime/bin/mongod"*) ;; *) exit 1 ;; esac
      kill -TERM "$process_id"
    fi
  fi
done
REMOTE
    ;;
  *)
    printf '%s\n' 'Usage: helios.sh prepare|upload|publish|start|status|stop' >&2
    exit 2
    ;;
esac
