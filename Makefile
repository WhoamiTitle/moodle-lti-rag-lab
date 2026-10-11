# Shell config
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

# Make config
.DEFAULT_GOAL := check
.SILENT:
MAKEFLAGS += --no-print-directory

# Script aliases
LOCAL_ENV := scripts/makefile/local_env.sh
MOODLE := scripts/makefile/moodle.sh
MONGO := scripts/makefile/mongo.sh
LTI_LOCAL := scripts/makefile/lti_local.sh
SHELL_CHECKS := scripts/makefile/shell_checks.sh
PHP_CHECKS := scripts/makefile/php_checks.sh
TEST_DOCKER := scripts/makefile/test_docker.sh
HELIOS := scripts/makefile/helios.sh

.PHONY: install lint format format-check test coverage check check-ci test-docker npm-audit
install:
	npm ci

lint:
	npm run lint
	$(SHELL_CHECKS) check
	$(PHP_CHECKS)

format:
	npm run lint:fix
	npm run format
	$(SHELL_CHECKS) format

format-check:
	npm run format:check
	$(SHELL_CHECKS) format-check

test:
	npm test

coverage:
	npm run test:coverage

check: lint format-check test

check-ci: check

test-docker:
	$(TEST_DOCKER)

npm-audit:
	npm audit

.PHONY: local-env start demo mongo-up mongo-down
local-env:
	$(LOCAL_ENV) app

start:
	npm start

demo:
	npm run demo

mongo-up: local-env
	$(MONGO) up

mongo-down:
	$(MONGO) down

.PHONY: lti-local-init lti-local-start lti-local-activate lti-local-status lti-local-instructor lti-local-verify
lti-local-init:
	$(LTI_LOCAL) init

lti-local-start:
	$(LTI_LOCAL) start

lti-local-activate:
	$(LTI_LOCAL) activate

lti-local-status:
	$(LTI_LOCAL) status

lti-local-instructor:
	$(LTI_LOCAL) instructor

lti-local-verify:
	$(LTI_LOCAL) verify

.PHONY: moodle-env moodle-init moodle-up moodle-install moodle-start moodle-stop moodle-restart moodle-down moodle-status moodle-logs moodle-cron
moodle-env:
	$(LOCAL_ENV) moodle

moodle-init:
	$(MOODLE) init

moodle-up:
	$(MOODLE) up

moodle-install:
	$(MOODLE) install

moodle-start:
	$(MOODLE) start

moodle-stop:
	$(MOODLE) stop

moodle-restart:
	$(MOODLE) restart

moodle-down:
	$(MOODLE) down

moodle-status:
	$(MOODLE) status

moodle-logs:
	$(MOODLE) logs

moodle-cron:
	$(MOODLE) cron

.PHONY: help
help:
	printf '%s\n' \
	  'make install           Install dependencies from package-lock.json' \
	  'make check[-ci]        Non-mutating lint, formatting and tests' \
	  'make format            Apply ESLint/Prettier/shfmt fixes' \
	  'make test-docker       Run isolated Node.js tests in Docker' \
	  'make demo              Run the local mock LTI platform and tool' \
	  'make moodle-init       Prepare env, build and install local Moodle' \
	  'make moodle-status     Inspect only the local Moodle stack' \
	  'make moodle-stop/start Stop/start Moodle, preserving its volumes' \
	  'make lti-local-init    Prepare real local LTI course, students and registration' \
	  'make lti-local-start   Start the real LTI tool with its private local configuration' \
	  'make lti-local-activate Register the running tool public key in local Moodle' \
	  'make lti-local-status Read actual Moodle grades; no grade writes' \
	  'make lti-local-instructor Prepare a course-only synthetic Instructor' \
	  'make lti-local-verify  Check live local 400/403; never sends a valid score' \
	  'make help              Show these commands'

.PHONY: helios-prepare helios-upload helios-publish helios-start helios-status helios-stop
helios-prepare:
	$(HELIOS) prepare

helios-upload:
	$(HELIOS) upload

helios-publish:
	$(HELIOS) publish

helios-start:
	$(HELIOS) start

helios-status:
	$(HELIOS) status

helios-stop:
	$(HELIOS) stop
