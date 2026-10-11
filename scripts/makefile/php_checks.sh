#!/bin/bash
# Called from Makefile; reuse the exact PHP image selected for Moodle.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
php_image="$(awk '$1 == "FROM" { print $2; exit }' "$repository_root/docker/moodle/Dockerfile")"
if [[ -z "$php_image" ]]; then
  printf '%s\n' 'No PHP base image found in docker/moodle/Dockerfile.' >&2
  exit 1
fi
docker run --rm --network none --mount "type=bind,source=$repository_root,target=/work,readonly" \
  --workdir /work --entrypoint /bin/bash "$php_image" -eu -o pipefail -c \
  'for php_file in docker/moodle/*.php deploy/helios/public/*.php; do php -l "$php_file"; done'
