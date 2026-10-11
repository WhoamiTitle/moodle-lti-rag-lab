#!/bin/bash
# Called from Makefile; the existing wrapper owns Compose/env selection.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_script="$repository_root/scripts/moodle.sh"
if [[ "$#" -ne 1 ]]; then
  printf '%s\n' 'Usage: moodle.sh init|up|install|start|stop|restart|down|status|logs|cron' >&2
  exit 2
fi

install_moodle() {
  "$compose_script" exec -T --user www-data moodle php /opt/moodle-lab/install.php
  "$compose_script" exec -T --user www-data moodle php admin/cli/purge_caches.php
  "$compose_script" up -d --wait --wait-timeout 60
}

case "$1" in
  init)
    "$repository_root/scripts/makefile/local_env.sh" moodle
    "$compose_script" up -d --build
    install_moodle
    ;;
  up) "$compose_script" up -d --build ;;
  install) install_moodle ;;
  start) "$compose_script" start ;;
  stop) "$compose_script" stop ;;
  restart) "$compose_script" restart ;;
  down) "$compose_script" down ;;
  status) "$compose_script" ps ;;
  logs) "$compose_script" logs --tail=100 moodle postgres ;;
  cron) "$compose_script" exec -T --user www-data moodle php admin/cli/cron.php ;;
  *)
    printf '%s\n' 'Unknown Moodle command; use make help.' >&2
    exit 2
    ;;
esac
