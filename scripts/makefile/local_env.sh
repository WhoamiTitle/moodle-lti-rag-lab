#!/bin/bash
# Called from Makefile; never overwrite an existing local environment.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
environment_kind="${1:-app}"
if [[ "$#" -gt 1 ]]; then
  printf '%s\n' 'Usage: local_env.sh [app|moodle]' >&2
  exit 2
fi

case "$environment_kind" in
  app)
    environment_template="$repository_root/.env.example"
    environment_target="$repository_root/.env"
    ;;
  moodle)
    environment_template="$repository_root/.env.moodle.example"
    environment_target="$repository_root/.env.moodle"
    ;;
  *)
    printf '%s\n' 'Usage: local_env.sh [app|moodle]' >&2
    exit 2
    ;;
esac

if [[ -e "$environment_target" || -L "$environment_target" ]]; then
  printf '%s\n' "Preserved existing $(basename -- "$environment_target"); no values changed."
  exit 0
fi

umask 077
environment_temporary="$(mktemp "$environment_target.XXXXXX")"
trap 'rm -f -- "$environment_temporary"' EXIT

database_password=''
admin_password=''
generate_password() {
  node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("hex"));'
}
if [[ "$environment_kind" == moodle ]]; then
  database_password="$(generate_password)"
  admin_password="Moodle!$(generate_password)Aa1"
fi

while IFS= read -r template_line || [[ -n "$template_line" ]]; do
  case "$environment_kind:$template_line" in
    moodle:MOODLE_LAB_DB_PASSWORD=*)
      printf '%s=%s\n' 'MOODLE_LAB_DB_PASSWORD' "$database_password"
      ;;
    moodle:MOODLE_LAB_ADMIN_PASSWORD=*)
      printf '%s=%s\n' 'MOODLE_LAB_ADMIN_PASSWORD' "$admin_password"
      ;;
    *) printf '%s\n' "$template_line" ;;
  esac
done < "$environment_template" > "$environment_temporary"

# A hard link publishes the complete file atomically, without replacing a
# concurrent creator's file. The temporary link is removed by the EXIT trap.
ln -- "$environment_temporary" "$environment_target"
printf '%s\n' "Created $(basename -- "$environment_target") with private permissions; values were not printed."
