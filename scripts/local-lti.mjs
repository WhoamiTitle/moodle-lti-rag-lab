import { execFile } from "node:child_process";
import { createPublicKey, randomBytes } from "node:crypto";
import { link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv, promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const TOOL_ORIGIN = "http://localhost:3000";
const MOODLE_ORIGIN = "http://localhost:8000";

async function readPrivateFile(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error(`${path.basename(filename)} must be a private regular file (mode 600); it was not changed.`);
    }
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function ensurePrivateEnvironment(filename, contents) {
  const temporary = await mkdtemp(`${filename}.`);
  const source = path.join(temporary, "environment");
  try {
    await writeFile(source, contents, { mode: 0o600, flag: "wx" });
    try {
      await link(source, filename);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const actual = parseEnv(await readPrivateFile(filename));
      const expected = parseEnv(contents);
      if (Object.keys(expected).some((key) => actual[key] !== expected[key])) {
        throw new Error(`${path.basename(filename)} contains another configuration; it was not overwritten.`, {
          cause: error,
        });
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureStudentCredentials(directory) {
  const filename = path.join(directory, ".env.lti-students");
  let contents = await readPrivateFile(filename);
  if (contents === null) {
    contents = [
      "# Synthetic local Moodle students. Do not share or commit this file.",
      "LTI_LAB_STUDENT_A_USER=lti_student_a",
      `LTI_LAB_STUDENT_A_PASSWORD=Lti!${randomBytes(24).toString("hex")}Aa1`,
      "LTI_LAB_STUDENT_B_USER=lti_student_b",
      `LTI_LAB_STUDENT_B_PASSWORD=Lti!${randomBytes(24).toString("hex")}Aa1`,
      "",
    ].join("\n");
    await ensurePrivateEnvironment(filename, contents);
  }
  const env = parseEnv(contents);
  if (
    env.LTI_LAB_STUDENT_A_USER !== "lti_student_a" ||
    env.LTI_LAB_STUDENT_B_USER !== "lti_student_b" ||
    !/^Lti![a-f0-9]{48}Aa1$/.test(env.LTI_LAB_STUDENT_A_PASSWORD) ||
    !/^Lti![a-f0-9]{48}Aa1$/.test(env.LTI_LAB_STUDENT_B_PASSWORD)
  ) {
    throw new Error("Invalid .env.lti-students; credentials were not reset.");
  }
  return { a: env.LTI_LAB_STUDENT_A_PASSWORD, b: env.LTI_LAB_STUDENT_B_PASSWORD };
}

export async function ensureInstructorCredentials(directory) {
  const filename = path.join(directory, ".env.lti-instructor");
  let contents = await readPrivateFile(filename);
  if (contents === null) {
    contents = [
      "# Synthetic course-only Instructor. Never share or commit.",
      "LTI_LAB_INSTRUCTOR_USER=lti_instructor",
      `LTI_LAB_INSTRUCTOR_PASSWORD=Lti!${randomBytes(24).toString("hex")}Aa1`,
      "",
    ].join("\n");
    await ensurePrivateEnvironment(filename, contents);
  }
  const env = parseEnv(contents);
  if (
    env.LTI_LAB_INSTRUCTOR_USER !== "lti_instructor" ||
    !/^Lti![a-f0-9]{48}Aa1$/.test(env.LTI_LAB_INSTRUCTOR_PASSWORD)
  ) {
    throw new Error("Invalid .env.lti-instructor; credentials were not reset.");
  }
  return { password: env.LTI_LAB_INSTRUCTOR_PASSWORD };
}

export function buildToolEnvironment(registration) {
  const expectedUrls = {
    platformid: MOODLE_ORIGIN,
    authrequesturl: `${MOODLE_ORIGIN}/mod/lti/auth.php`,
    accesstokenurl: `${MOODLE_ORIGIN}/mod/lti/token.php`,
    publickeyseturl: `${MOODLE_ORIGIN}/mod/lti/certs.php`,
  };
  if (
    Object.entries(expectedUrls).some(([key, url]) => registration[key] !== url) ||
    typeof registration.clientid !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(registration.clientid) ||
    !/^\d+$/.test(String(registration.deploymentid))
  ) {
    throw new Error("Unexpected Moodle registration; only this loopback lab is supported.");
  }
  return [
    "# Generated from the actual local Moodle registration. Do not commit.",
    "PORT=3000",
    "LISTEN_HOST=127.0.0.1",
    `PUBLIC_URL=${TOOL_ORIGIN}`,
    'APP_LABEL="RAG · Учебный тренажёр"',
    "MONGO_URL=mongodb://127.0.0.1:27017/moodle_lti_rag_lab",
    "DATA_DIR=./data/local-lti-attempts",
    `MOODLE_ISSUER=${registration.platformid}`,
    `MOODLE_CLIENT_ID=${registration.clientid}`,
    `MOODLE_DEPLOYMENT_ID=${registration.deploymentid}`,
    `MOODLE_AUTH_URL=${registration.authrequesturl}`,
    `MOODLE_TOKEN_URL=${registration.accesstokenurl}`,
    `MOODLE_JWKS_URL=${registration.publickeyseturl}`,
    "",
  ].join("\n");
}

export async function runMoodle(command, input = "") {
  const execution = execute(
    "/bin/bash",
    [
      path.join(repositoryRoot, "scripts/moodle.sh"),
      "exec",
      "-T",
      "--user",
      "www-data",
      "moodle",
      "php",
      "/opt/moodle-lab/lti-lab.php",
      command,
    ],
    { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  execution.child.stdin.end(input);
  try {
    const { stdout } = await execution;
    return JSON.parse(stdout);
  } catch (error) {
    // Do not echo subprocess arguments, STDIN, environment or a PHP stack trace.
    throw new Error(`Local Moodle helper failed (${error.code || error.name}); inspect the scoped Moodle logs.`, {
      cause: error,
    });
  }
}

async function main(command) {
  let snapshot;
  if (command === "prepare") {
    const credentials = await ensureStudentCredentials(repositoryRoot);
    snapshot = await runMoodle("prepare", JSON.stringify(credentials));
    await ensurePrivateEnvironment(
      path.join(repositoryRoot, ".env.lti-local"),
      buildToolEnvironment(snapshot.registration),
    );
  } else if (command === "activate") {
    const localEnv = parseEnv((await readPrivateFile(path.join(repositoryRoot, ".env.lti-local"))) || "");
    if (localEnv.PUBLIC_URL !== TOOL_ORIGIN) {
      throw new Error("Prepare .env.lti-local before activating the tool.");
    }
    snapshot = await runMoodle("status");
    if (parseEnv(buildToolEnvironment(snapshot.registration)).MOODLE_CLIENT_ID !== localEnv.MOODLE_CLIENT_ID) {
      throw new Error("Moodle client ID differs; no registration was changed.");
    }
    const response = await fetch(`${TOOL_ORIGIN}/tool-public-key`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error("Start the real tool with make lti-local-start before activating it.");
    }
    const publicKey = await response.text();
    const parsedKey = createPublicKey(publicKey);
    if (parsedKey.asymmetricKeyType !== "rsa" || parsedKey.asymmetricKeyDetails.modulusLength < 2048) {
      throw new Error("The real tool did not return a valid RSA public key.");
    }
    snapshot = await runMoodle("activate", publicKey);
  } else if (command === "status") {
    snapshot = await runMoodle("status");
  } else if (command === "instructor") {
    const credentials = await ensureInstructorCredentials(repositoryRoot);
    snapshot = await runMoodle("instructor", JSON.stringify(credentials));
  } else {
    throw new Error("Usage: local-lti.mjs prepare|activate|status|instructor");
  }
  console.log(JSON.stringify(snapshot, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Usage: local-lti.mjs prepare|activate|status|instructor");
    }
    await main(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
