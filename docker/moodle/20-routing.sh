#!/bin/bash
set -eu -o pipefail

# The image's 10-wwwroot.sh creates a Location-wide fallback first.
# Replace it with the Directory-scoped configuration after root detection.
cp /opt/moodle-lab/fallback.conf /etc/apache2/conf-enabled/fallback.conf
apache2ctl -t
