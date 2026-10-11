#!/bin/bash
# Real, loopback-only Moodle integration; never selects the mock platform.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$#" -ne 1 ]]; then
  printf '%s\n' 'Usage: lti_local.sh init|start|activate|status|instructor|verify' >&2
  exit 2
fi
cd -- "$repository_root"
case "$1" in
  init)
    "$repository_root/scripts/makefile/moodle.sh" up
    "$repository_root/scripts/moodle.sh" up -d --wait --wait-timeout 60
    "$repository_root/scripts/makefile/local_env.sh" app
    "$repository_root/scripts/makefile/mongo.sh" up
    node scripts/local-lti.mjs prepare
    ;;
  start) exec node --env-file=.env.lti-local src/server.mjs ;;
  activate) exec node scripts/local-lti.mjs activate ;;
  status) exec node scripts/local-lti.mjs status ;;
  instructor) exec node scripts/local-lti.mjs instructor ;;
  verify) exec node scripts/verify-local-lti.mjs ;;
  *)
    printf '%s\n' 'Usage: lti_local.sh init|start|activate|status|instructor|verify' >&2
    exit 2
    ;;
esac
