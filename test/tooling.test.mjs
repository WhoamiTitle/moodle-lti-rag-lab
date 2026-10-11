import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rag-lab-tooling-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "scripts/makefile"), { recursive: true });
  await mkdir(path.join(directory, "bin"));
  for (const filename of [
    "scripts/moodle.sh",
    "scripts/makefile/local_env.sh",
    "scripts/makefile/moodle.sh",
    "scripts/makefile/lti_local.sh",
    "scripts/makefile/mongo.sh",
    "scripts/makefile/test_docker.sh",
    "scripts/makefile/helios.sh",
    ".env.example",
    ".env.moodle.example",
  ]) {
    await copyFile(path.join(repositoryRoot, filename), path.join(directory, filename));
    if (filename.endsWith(".sh")) {
      await chmod(path.join(directory, filename), 0o755);
    }
  }
  const log = path.join(directory, "docker-arguments.txt");
  await writeFile(
    path.join(directory, "bin/docker"),
    '#!/bin/bash\nset -eu -o pipefail\nprintf "%s\\n" CALL "$@" >> "$LAB_TEST_DOCKER_LOG"\nexit "${LAB_TEST_DOCKER_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  return {
    directory,
    log,
    run(filename, args, extraEnv = {}) {
      return execute("/bin/bash", [path.join(directory, filename), ...args], {
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
          LAB_TEST_DOCKER_LOG: log,
          ...extraEnv,
        },
      });
    },
  };
}

test("local-env creates a private app configuration and never overwrites it", async (t) => {
  const files = await fixture(t);
  await files.run("scripts/makefile/local_env.sh", ["app"]);
  const target = path.join(files.directory, ".env");
  assert.equal(await readFile(target, "utf8"), await readFile(path.join(files.directory, ".env.example"), "utf8"));
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await writeFile(target, "PRESERVED=test-only-value\n");
  const before = await stat(target);
  const response = await files.run("scripts/makefile/local_env.sh", ["app"]);
  assert.equal(await readFile(target, "utf8"), "PRESERVED=test-only-value\n");
  assert.equal((await stat(target)).ino, before.ino);
  assert.match(response.stdout, /Preserved existing/);
  assert.doesNotMatch(response.stdout + response.stderr, /test-only-value/);
});

test("moodle-env generates separate private passwords without printing them", async (t) => {
  const files = await fixture(t);
  const response = await files.run("scripts/makefile/local_env.sh", ["moodle"]);
  const target = path.join(files.directory, ".env.moodle");
  const contents = await readFile(target, "utf8");
  const env = parseEnv(contents);
  assert.match(env.MOODLE_LAB_DB_PASSWORD, /^[0-9a-f]{48}$/);
  assert.match(env.MOODLE_LAB_ADMIN_PASSWORD, /^Moodle![0-9a-f]{48}Aa1$/);
  assert.notEqual(env.MOODLE_LAB_DB_PASSWORD, env.MOODLE_LAB_ADMIN_PASSWORD);
  assert.equal(env.MOODLE_LAB_URL, "http://localhost:8000");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.ok(!(response.stdout + response.stderr).includes(env.MOODLE_LAB_DB_PASSWORD));
  assert.ok(!(response.stdout + response.stderr).includes(env.MOODLE_LAB_ADMIN_PASSWORD));
  await files.run("scripts/makefile/local_env.sh", ["moodle"]);
  assert.equal(await readFile(target, "utf8"), contents);
});

test("env generation preserves an existing dangling symlink", async (t) => {
  const files = await fixture(t);
  const target = path.join(files.directory, ".env.moodle");
  const destination = path.join(files.directory, "not-created");
  await symlink(destination, target);
  await files.run("scripts/makefile/local_env.sh", ["moodle"]);
  assert.ok((await lstat(target)).isSymbolicLink());
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("env generation rejects unknown modes before creating files", async (t) => {
  const files = await fixture(t);
  await assert.rejects(files.run("scripts/makefile/local_env.sh", ["unknown"]), { code: 2 });
  await assert.rejects(stat(path.join(files.directory, ".env")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(files.directory, ".env.moodle")), { code: "ENOENT" });
});

test("Moodle wrapper uses only its own Compose and env from any working directory", async (t) => {
  const files = await fixture(t);
  await writeFile(path.join(files.directory, ".env.moodle"), "PRIVATE=test-only-secret\n");
  await files.run("scripts/moodle.sh", ["ps"]);
  const argumentsPassed = (await readFile(files.log, "utf8")).trim().split("\n");
  assert.deepEqual(argumentsPassed, [
    "CALL",
    "compose",
    "--project-directory",
    files.directory,
    "--env-file",
    path.join(files.directory, ".env.moodle"),
    "-f",
    path.join(files.directory, "compose.moodle.yaml"),
    "ps",
  ]);
  assert.ok(!argumentsPassed.includes("test-only-secret"));
});

test("Moodle install invokes www-data, clears cache and then waits for health", async (t) => {
  const files = await fixture(t);
  await writeFile(path.join(files.directory, ".env.moodle"), "");
  await files.run("scripts/makefile/moodle.sh", ["install"]);
  const calls = (await readFile(files.log, "utf8"))
    .split("CALL\n")
    .filter(Boolean)
    .map((call) => call.trim().split("\n"));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call[0], "compose");
    assert.ok(call.includes(path.join(files.directory, "compose.moodle.yaml")));
  }
  assert.deepEqual(calls[0].slice(-7), [
    "exec",
    "-T",
    "--user",
    "www-data",
    "moodle",
    "php",
    "/opt/moodle-lab/install.php",
  ]);
  assert.deepEqual(calls[1].slice(-7), [
    "exec",
    "-T",
    "--user",
    "www-data",
    "moodle",
    "php",
    "admin/cli/purge_caches.php",
  ]);
  assert.deepEqual(calls[2].slice(-5), ["up", "-d", "--wait", "--wait-timeout", "60"]);
});

test("Moodle install failure stops before cache clearing or another Docker call", async (t) => {
  const files = await fixture(t);
  await writeFile(path.join(files.directory, ".env.moodle"), "");
  await assert.rejects(files.run("scripts/makefile/moodle.sh", ["install"], { LAB_TEST_DOCKER_EXIT: "7" }), {
    code: 7,
  });
  const calls = await readFile(files.log, "utf8");
  assert.equal(calls.split("CALL\n").filter(Boolean).length, 1);
  assert.doesNotMatch(calls, /purge_caches|--wait/);
});

test("Moodle Make helper rejects extra destructive flags without calling Docker", async (t) => {
  const files = await fixture(t);
  await assert.rejects(files.run("scripts/makefile/moodle.sh", ["down", "-v"]), { code: 2 });
  await assert.rejects(stat(files.log), { code: "ENOENT" });
});

test("real LTI Make helper rejects unknown commands and extra flags before calling Docker", async (t) => {
  const files = await fixture(t);
  await assert.rejects(files.run("scripts/makefile/lti_local.sh", ["down"]), { code: 2 });
  await assert.rejects(files.run("scripts/makefile/lti_local.sh", ["init", "-v"]), { code: 2 });
  await assert.rejects(stat(files.log), { code: "ENOENT" });
});

test("Helios helper rejects unknown commands and extra flags before contacting the server", async (t) => {
  const files = await fixture(t);
  const sshLog = path.join(files.directory, "ssh-called");
  for (const command of ["ssh", "scp"]) {
    await writeFile(
      path.join(files.directory, `bin/${command}`),
      `#!/bin/bash\nprintf called > '${sshLog}'\nexit 99\n`,
      { mode: 0o755 },
    );
  }
  for (const args of [[], ["destroy"], ["stop", "--all"], ["prepare", "extra"]]) {
    await assert.rejects(files.run("scripts/makefile/helios.sh", args), { code: 2 });
  }
  await assert.rejects(stat(sshLog), { code: "ENOENT" });
});

test("Mongo helper waits for readiness within its own project and preserves the volume on down", async (t) => {
  const files = await fixture(t);
  await writeFile(path.join(files.directory, ".env"), "");
  await files.run("scripts/makefile/mongo.sh", ["up"]);
  await files.run("scripts/makefile/mongo.sh", ["down"]);
  const calls = (await readFile(files.log, "utf8"))
    .split("CALL\n")
    .filter(Boolean)
    .map((call) => call.trim().split("\n"));
  assert.ok(calls.every((call) => call.includes("moodle-lti-rag-lab")));
  assert.ok(calls.every((call) => call.includes(path.join(files.directory, "compose.yaml"))));
  assert.deepEqual(calls[0].slice(-6), ["up", "-d", "--wait", "--wait-timeout", "60", "mongo"]);
  assert.equal(calls[1].at(-1), "down");
  assert.ok(!calls[1].includes("-v"));
});

test("Docker test runner uses no real services, data mounts or published ports", async (t) => {
  const files = await fixture(t);
  await files.run("scripts/makefile/test_docker.sh", []);
  const calls = (await readFile(files.log, "utf8"))
    .split("CALL\n")
    .filter(Boolean)
    .map((call) => call.trim().split("\n"));
  assert.equal(calls[0][0], "build");
  assert.deepEqual(calls[1], [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=256m",
    "moodle-lti-rag-lab-test:local",
  ]);
});
