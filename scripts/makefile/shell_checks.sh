#!/bin/bash
# Called from Makefile; tool versions are identical on ARM64 and in CI.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repository_root"
shellcheck_image='koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d'
shfmt_image='mvdan/shfmt:v3.12.0@sha256:307d265ffd25ce832899ae17c93ed5062fc3375c514bba8f52cbf52792735c4d'
shell_files=(scripts/makefile/*.sh scripts/moodle.sh docker/moodle/20-routing.sh)

if [[ "$#" -ne 1 ]]; then
  printf '%s\n' 'Usage: shell_checks.sh check|format-check|format' >&2
  exit 2
fi
case "$1" in
  check)
    for shell_file in "${shell_files[@]}"; do bash -n "$shell_file"; done
    docker run --rm --network none --mount "type=bind,source=$repository_root,target=/work,readonly" \
      --workdir /work "$shellcheck_image" --severity=warning "${shell_files[@]}"
    ;;
  format-check)
    docker run --rm --network none --mount "type=bind,source=$repository_root,target=/work,readonly" \
      --workdir /work "$shfmt_image" -ln bash -i 2 -ci -bn -sr -d "${shell_files[@]}"
    ;;
  format)
    docker run --rm --network none --user "$(id -u):$(id -g)" \
      --mount "type=bind,source=$repository_root,target=/work" \
      --workdir /work "$shfmt_image" -ln bash -i 2 -ci -bn -sr -w "${shell_files[@]}"
    ;;
  *)
    printf '%s\n' 'Usage: shell_checks.sh check|format-check|format' >&2
    exit 2
    ;;
esac
