#!/bin/bash
set -eu -o pipefail

moodle_lab_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "${moodle_lab_root}/.env.moodle" ]]; then
  printf '%s\n' 'Missing .env.moodle. Copy .env.moodle.example and set both passwords; see docs/local-moodle.md.' >&2
  exit 1
fi

exec docker compose \
  --project-directory "${moodle_lab_root}" \
  --env-file "${moodle_lab_root}/.env.moodle" \
  -f "${moodle_lab_root}/compose.moodle.yaml" \
  "$@"
