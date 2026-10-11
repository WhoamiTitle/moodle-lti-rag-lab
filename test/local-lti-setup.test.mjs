import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import {
  buildToolEnvironment,
  ensureInstructorCredentials,
  ensurePrivateEnvironment,
  ensureStudentCredentials,
} from "../scripts/local-lti.mjs";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rag-local-lti-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("local Instructor credentials are private, separate from learners and preserved on repeat", async (t) => {
  const directory = await temporaryDirectory(t);
  const credentials = await ensureInstructorCredentials(directory);
  const learners = await ensureStudentCredentials(directory);
  assert.match(credentials.password, /^Lti![a-f0-9]{48}Aa1$/);
  assert.notEqual(credentials.password, learners.a);
  assert.notEqual(credentials.password, learners.b);
  const before = await lstat(path.join(directory, ".env.lti-instructor"));
  assert.equal(before.mode & 0o777, 0o600);
  assert.deepEqual(await ensureInstructorCredentials(directory), credentials);
  assert.equal((await lstat(path.join(directory, ".env.lti-instructor"))).ino, before.ino);
});

test("Instructor credentials reject symlinks and malformed files without resetting them", async (t) => {
  const directory = await temporaryDirectory(t);
  const filename = path.join(directory, ".env.lti-instructor");
  const target = path.join(directory, "preserved");
  await writeFile(target, "PRESERVED=yes\n", { mode: 0o600 });
  await symlink(target, filename);
  await assert.rejects(ensureInstructorCredentials(directory), /private regular file/);
  await rm(filename);
  await writeFile(filename, "PRESERVED=yes\n", { mode: 0o600 });
  await assert.rejects(ensureInstructorCredentials(directory), /credentials were not reset/);
  assert.equal(await readFile(filename, "utf8"), "PRESERVED=yes\n");
  assert.equal(await readFile(target, "utf8"), "PRESERVED=yes\n");
});

test("real local LTI preparation creates private distinct credentials and preserves them on repeat", async (t) => {
  const directory = await temporaryDirectory(t);
  const credentials = await ensureStudentCredentials(directory);
  assert.match(credentials.a, /^Lti![a-f0-9]{48}Aa1$/);
  assert.match(credentials.b, /^Lti![a-f0-9]{48}Aa1$/);
  assert.notEqual(credentials.a, credentials.b);
  const filename = path.join(directory, ".env.lti-students");
  const before = await lstat(filename);
  assert.equal(before.mode & 0o777, 0o600);
  assert.deepEqual(await ensureStudentCredentials(directory), credentials);
  assert.equal((await lstat(filename)).ino, before.ino);
});

test("local LTI credential generation rejects a symlink without reading or replacing its target", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = path.join(directory, "other-file");
  await writeFile(target, "preserved", { mode: 0o600 });
  const filename = path.join(directory, ".env.lti-students");
  await symlink(target, filename);
  await assert.rejects(ensureStudentCredentials(directory), /private regular file/);
  assert.ok((await lstat(filename)).isSymbolicLink());
  assert.equal(await readFile(target, "utf8"), "preserved");
});

test("local LTI credential generation rejects exposed or malformed existing files without a reset", async (t) => {
  const directory = await temporaryDirectory(t);
  const filename = path.join(directory, ".env.lti-students");
  await writeFile(filename, "PRESERVED=synthetic-only\n", { mode: 0o644 });
  await assert.rejects(ensureStudentCredentials(directory), /private regular file/);
  await chmod(filename, 0o600);
  await assert.rejects(ensureStudentCredentials(directory), /credentials were not reset/);
  assert.equal(await readFile(filename, "utf8"), "PRESERVED=synthetic-only\n");
});

test("private local LTI env publication is repeatable but rejects another registration without overwriting it", async (t) => {
  const directory = await temporaryDirectory(t);
  const filename = path.join(directory, ".env.lti-local");
  await ensurePrivateEnvironment(filename, "MOODLE_CLIENT_ID=first\n");
  const before = await lstat(filename);
  await ensurePrivateEnvironment(filename, "# Another comment\nMOODLE_CLIENT_ID=first\n");
  await assert.rejects(ensurePrivateEnvironment(filename, "MOODLE_CLIENT_ID=second\n"), /not overwritten/);
  assert.equal(await readFile(filename, "utf8"), "MOODLE_CLIENT_ID=first\n");
  assert.equal((await lstat(filename)).ino, before.ino);
  assert.equal(before.mode & 0o777, 0o600);
});

const registration = {
  platformid: "http://localhost:8000",
  clientid: "synthetic-client",
  deploymentid: 1,
  authrequesturl: "http://localhost:8000/mod/lti/auth.php",
  accesstokenurl: "http://localhost:8000/mod/lti/token.php",
  publickeyseturl: "http://localhost:8000/mod/lti/certs.php",
};

test("real local LTI env binds exact Moodle metadata, a real MongoDB and a separate attempt directory", () => {
  const env = parseEnv(buildToolEnvironment(registration));
  assert.equal(env.PUBLIC_URL, "http://localhost:3000");
  assert.equal(env.LISTEN_HOST, "127.0.0.1");
  assert.equal(env.MOODLE_ISSUER, registration.platformid);
  assert.equal(env.MOODLE_CLIENT_ID, registration.clientid);
  assert.equal(env.MOODLE_DEPLOYMENT_ID, "1");
  assert.equal(env.MOODLE_AUTH_URL, registration.authrequesturl);
  assert.equal(env.MOODLE_TOKEN_URL, registration.accesstokenurl);
  assert.equal(env.MOODLE_JWKS_URL, registration.publickeyseturl);
  assert.equal(env.MONGO_URL, "mongodb://127.0.0.1:27017/moodle_lti_rag_lab");
  assert.equal(env.DATA_DIR, "./data/local-lti-attempts");
  assert.equal(env.LTI_LAB_STUDENT_A_PASSWORD, undefined);
});

test("local LTI preparation rejects foreign URLs and env-injection identifiers", () => {
  for (const changes of [
    { platformid: "https://moodle.example" },
    { publickeyseturl: "http://localhost:8000/mod/lti/certs.php?other=1" },
    { accesstokenurl: "http://127.0.0.1:8000/mod/lti/token.php" },
    { authrequesturl: "http://localhost:8000/mod/lti/auth.php#fragment" },
    { clientid: "synthetic\nLISTEN_HOST=0.0.0.0" },
    { deploymentid: "1\nPUBLIC_URL=https://other.example" },
  ]) {
    assert.throws(() => buildToolEnvironment({ ...registration, ...changes }), /only this loopback lab/);
  }
});
