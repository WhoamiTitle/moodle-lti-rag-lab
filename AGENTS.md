# Repository conventions

## Scope and structure

- This is a Node.js 24 ESM application, not a Python project. Use `.mjs`, the built-in Node.js test runner and the locked npm dependencies.
- `src/` contains grading, attempts, sessions and the LTI boundary. `public/` contains the browser interface. Keep test doubles in `test-support/`; never enable a mock platform in the ordinary server.
- Follow the tooling organization of `fastapi-clean-example`: stable Make targets and executable helpers in `scripts/makefile/`. Do not create empty architecture layers or port Python-only tools such as Ruff/mypy into JavaScript.
- Preserve HTTP/LTI contracts, the persisted attempt schema and the ordering of persistence before AGS delivery. Refactor in small, tested steps.

## Code style

- Run `make format` for deliberate fixes; `make check-ci` must only check, never rewrite source files.
- JavaScript, HTML, CSS and configuration use Prettier: two spaces, double quotes, semicolons, LF and a 120-column target. ESLint checks the source, browser code, scripts, tests and test doubles.
- Use explicit imports, `const` when possible, braces around control-flow bodies and strict equality. Avoid unused bindings and `eval`.
- Name the domain concept: `snapshot`, `session`, `context`, `oidcState`, etc. Do not name a generic local variable or parameter `state`. The standard OIDC `state` field and documented external APIs must retain their protocol names.
- Shell helpers use `#!/bin/bash`, `set -eu -o pipefail`, quoted expansions and paths resolved from the script location. Keep multi-step shell logic out of Make recipes. Use ShellCheck and shfmt through the repository helpers.
- Run Moodle CLI tasks as `www-data`. PHP helpers are checked with the pinned Moodle PHP image.

## Verification

- After changing code, run `make check-ci`. Use `make test-docker` when changing dependencies, shell helpers or container configuration.
- Keep existing assertions and negative/security scenarios; do not add skips or broad lint/coverage exclusions just to make a check pass.
- `make coverage` measures `src/`; it does not prove production MongoDB, real Moodle integration or browser rendering.
- Automation tests use temporary directories and a fake Docker executable. Docker tests must not mount real data or publish ports. Keep manual verification of the actual local Moodle separate from mock LTI/AGS tests.
- Do not claim a GitHub workflow ran merely because its YAML was added, or that Git hooks are installed merely because their configuration exists.

## Local environments and Git

- Generate configuration with `make local-env` or `make moodle-env`. These commands must preserve an existing file or symlink, create new files with mode `600` and never print secret values.
- Never commit `.env`, `.env.moodle`, private keys, `data/`, `node_modules/` or real learner data. Example env files must contain no real secrets.
- Use the scoped `make moodle-*` / `make mongo-*` commands. Never stop unrelated containers, perform a global Docker prune or remove persistent volumes without an explicit, target-specific request.
- Preserve unrelated worktree changes. Do not stage, commit or push unless the user authorizes that step.

The rationale and command reference are in [docs/development.md](docs/development.md).
