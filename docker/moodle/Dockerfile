FROM moodlehq/moodle-php-apache:8.3@sha256:501f19fa75ad3cdc8962f2a742f39d179b8aa8ffdc2ff233d8d27a32f14e0e05

# Official release archive, not a floating stable-branch download.
ARG MOODLE_VERSION=5.3
ARG MOODLE_SHA256=7e5edf110555956571f40e42acffde0eb23681ebebd212a2fec0fe7d795dd511
RUN curl --fail --silent --show-error --location --retry 3 \
      "https://packaging.moodle.org/stable503/moodle-${MOODLE_VERSION}.tgz" \
      --output /tmp/moodle-release.tgz \
    && printf '%s  %s\n' "${MOODLE_SHA256}" /tmp/moodle-release.tgz | sha256sum --check - \
    && tar --extract --gzip --file /tmp/moodle-release.tgz \
      --directory /var/www/html --strip-components=1 \
    && rm /tmp/moodle-release.tgz

COPY config.php /var/www/html/config.php
COPY install.php health.php lti-lab.php /opt/moodle-lab/
COPY fallback.conf /opt/moodle-lab/fallback.conf
COPY --chmod=755 20-routing.sh /docker-entrypoint.d/20-routing.sh
RUN php -l /var/www/html/config.php \
    && php -l /opt/moodle-lab/install.php \
    && php -l /opt/moodle-lab/health.php \
    && php -l /opt/moodle-lab/lti-lab.php \
    && bash -n /docker-entrypoint.d/20-routing.sh

WORKDIR /var/www/html
