#!/bin/bash
# Called from Makefile; no real Moodle, MongoDB, host ports or data mounts.
set -eu -o pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_image='moodle-lti-rag-lab-test:local'
docker build --file "$repository_root/Dockerfile.test" --tag "$test_image" "$repository_root"
# Shell tests execute their fake Docker/helper scripts inside temporary fixtures.
docker run --rm --network none --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m "$test_image"
