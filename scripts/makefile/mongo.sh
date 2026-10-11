#!/bin/bash
# Called from Makefile; scope operations to this repository's LTI database.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$#" -ne 1 ]]; then
  printf '%s\n' 'Usage: mongo.sh up|down' >&2
  exit 2
fi
compose=(docker compose --project-directory "$repository_root"
  --project-name moodle-lti-rag-lab --env-file "$repository_root/.env"
  -f "$repository_root/compose.yaml")

case "$1" in
  up) "${compose[@]}" up -d --wait --wait-timeout 60 mongo ;;
  down) "${compose[@]}" down ;;
  *)
    printf '%s\n' 'Usage: mongo.sh up|down' >&2
    exit 2
    ;;
esac
