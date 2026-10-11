// Live protocol checks, not a browser driver or a mock platform.
// Every session comes from a fresh, signed launch issued by the real local Moodle.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { buildToolEnvironment, runMoodle } from "./local-lti.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const MOODLE = "http://localhost:8000";
const TOOL = "http://localhost:3000";
const INSTRUCTOR = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";

function decodeAttribute(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (_entity, code) => {
    if (code.startsWith("#")) {
      return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    }
    return { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[code.toLowerCase()];
  });
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => [
      match[1].toLowerCase(),
      decodeAttribute(match[2] ?? match[3]),
    ]),
  );
}

export function parseForm(html, id) {
  const matches = [...html.matchAll(/(<form\b[^>]*>)([\s\S]*?)<\/form>/gi)].filter(
    (match) => !id || attributes(match[1]).id === id,
  );
  assert.equal(matches.length, 1, "Expected exactly one protocol form");
  const [match] = matches;
  const form = attributes(match[1]);
  assert.equal(form.method?.toLowerCase(), "post", "Expected a POST protocol form");
  const parameters = new URLSearchParams();
  for (const input of match[2].matchAll(/<input\b[^>]*>/gi)) {
    const field = attributes(input[0]);
    if (field.name && field.type?.toLowerCase() !== "submit") {
      assert.ok(!parameters.has(field.name), "Duplicate protocol field");
      parameters.set(field.name, field.value || "");
    }
  }
  return { action: form.action, parameters };
}

export function assertLocalUrl(value, base = MOODLE) {
  const url = new URL(value, base);
  assert.ok(
    [MOODLE, TOOL].includes(url.origin) && !url.username && !url.password && !url.hash,
    "Non-local protocol URL",
  );
  return url;
}

class LocalProtocolClient {
  cookies = new Map();

  async request(value, options = {}) {
    const url = assertLocalUrl(value);
    const cookieJar = this.cookies.get(url.origin) || new Map();
    const headers = new Headers(options.headers);
    if (cookieJar.size) {
      headers.set("Cookie", [...cookieJar].map(([name, cookie]) => `${name}=${cookie}`).join("; "));
    }
    const response = await fetch(url, {
      ...options,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const contents = pair.slice(separator + 1);
      if (contents && !/max-age=0\b/i.test(cookie)) {
        cookieJar.set(name, contents);
      } else {
        cookieJar.delete(name);
      }
    }
    this.cookies.set(url.origin, cookieJar);
    return response;
  }

  async follow(value, options = {}) {
    let response = await this.request(value, options);
    for (let count = 0; count < 8 && [301, 302, 303].includes(response.status); count += 1) {
      const location = response.headers.get("location");
      assert.ok(location, "Missing redirect location");
      response = await this.request(assertLocalUrl(location, response.url));
    }
    assert.equal(response.status, 200, "Protocol page did not load");
    return response;
  }
}

async function privateEnvironment(filename) {
  const info = await lstat(filename);
  assert.ok(info.isFile() && (info.mode & 0o077) === 0, "Environment must be private and not a symlink");
  return parseEnv(await readFile(filename, "utf8"));
}

async function liveSession(username, password, courseModuleId) {
  assert.ok(typeof password === "string" && password, "Missing private account credentials");
  const client = new LocalProtocolClient();
  const loginPage = await client.follow(`${MOODLE}/login/index.php`);
  const login = parseForm(await loginPage.text(), "login");
  assert.equal(assertLocalUrl(login.action).href, `${MOODLE}/login/index.php`);
  assert.ok(login.parameters.get("logintoken"), "Missing Moodle login token");
  login.parameters.set("username", username);
  login.parameters.set("password", password);
  await client.follow(login.action, { method: "POST", headers: { Origin: MOODLE }, body: login.parameters });

  const launchPage = await client.follow(`${MOODLE}/mod/lti/launch.php?id=${courseModuleId}&triggerview=0`);
  const initiate = parseForm(await launchPage.text());
  assert.equal(assertLocalUrl(initiate.action).href, `${TOOL}/lti/login`);
  const loginResponse = await client.follow(initiate.action, {
    method: "POST",
    headers: { Origin: MOODLE },
    body: initiate.parameters,
  });
  const dataMatch = (await loginResponse.text()).match(/id="ltijs-login-data">([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, "Missing real ltijs OIDC recovery data");
  const loginData = JSON.parse(dataMatch[1]);
  assert.equal(assertLocalUrl(loginData.targetUrl).pathname, "/mod/lti/auth.php");
  const authentication = await client.follow(loginData.targetUrl);
  const signedLaunch = parseForm(await authentication.text(), "ltiAuthForm");
  assert.equal(assertLocalUrl(signedLaunch.action).href, `${TOOL}/lti/launch`);
  assert.ok(signedLaunch.parameters.get("id_token"), "Moodle did not issue a signed id_token");

  const recovery = await client.request(signedLaunch.action, {
    method: "POST",
    headers: { Origin: MOODLE },
    body: signedLaunch.parameters,
  });
  assert.equal(recovery.status, 200, "Expected the real state recovery page");
  assert.match(await recovery.text(), /ltijs_recovered_state/);
  // Return the actual recovery token supplied by ltijs; no synthetic JWT or claims.
  signedLaunch.parameters.set("ltijs_recovered_state", loginData.recoveryToken);
  const verified = await client.request(signedLaunch.action, {
    method: "POST",
    headers: { Origin: TOOL, "Sec-Fetch-Site": "same-origin" },
    body: signedLaunch.parameters,
  });
  assert.equal(verified.status, 302, "Real signed launch was rejected");
  const activationUrl = assertLocalUrl(verified.headers.get("location"), TOOL);
  assert.equal(activationUrl.origin, TOOL);
  assert.equal(activationUrl.pathname, "/session/start");
  const activation = await client.request(activationUrl);
  assert.equal(activation.status, 303, "Session ticket was not activated");
  const response = await client.request(`${TOOL}/api/session`);
  assert.equal(response.status, 200, "Real session is unavailable");
  return { client, session: await response.json() };
}

async function attemptDigests() {
  const directory = path.join(repositoryRoot, "data/local-lti-attempts");
  const files = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  return Promise.all(
    files.map(async (name) => ({
      name,
      sha256: createHash("sha256")
        .update(await readFile(path.join(directory, name)))
        .digest("hex"),
    })),
  );
}

function gradeSnapshot(snapshot) {
  return {
    gradeItemId: snapshot.gradeItemId,
    ltiGradeItemCount: snapshot.ltiGradeItemCount,
    learners: snapshot.learners.map(({ username, userId, grade, history }) => ({ username, userId, grade, history })),
    instructor: snapshot.instructor,
  };
}

export async function verifyLiveLocalLti() {
  const before = await runMoodle("status");
  const toolEnv = await privateEnvironment(path.join(repositoryRoot, ".env.lti-local"));
  const expected = parseEnv(buildToolEnvironment(before.registration));
  assert.ok(
    Object.entries(expected).every(([key, value]) => toolEnv[key] === value),
    "Unexpected local registration",
  );
  assert.ok(
    before.active && before.instructor && !before.instructor.siteAdmin,
    "Prepare a course-only Instructor first",
  );
  assert.deepEqual(before.instructor.courseRoles, ["teacher"]);
  assert.deepEqual(
    before.learners.map(({ grade }) => grade),
    [10, 7],
    "Leave A=10 and B=7 before running checks",
  );
  assert.equal(before.ltiGradeItemCount, 1);
  assert.equal(before.instructor.gradeRows, 0);
  assert.equal(before.instructor.gradeHistoryRows, 0);
  const originalGrades = gradeSnapshot(before);
  const originalAttempts = await attemptDigests();
  assert.equal(originalAttempts.length, 2, "Only the two learners should have attempt files");

  const students = await privateEnvironment(path.join(repositoryRoot, ".env.lti-students"));
  const teacher = await privateEnvironment(path.join(repositoryRoot, ".env.lti-instructor"));
  const learner = await liveSession(
    students.LTI_LAB_STUDENT_B_USER,
    students.LTI_LAB_STUDENT_B_PASSWORD,
    before.courseModuleId,
  );
  assert.equal(learner.session.userId, before.learners[1].userId);
  assert.equal(learner.session.learner, true);
  assert.equal(learner.session.current.scoreGiven, 7);
  const instructor = await liveSession(
    teacher.LTI_LAB_INSTRUCTOR_USER,
    teacher.LTI_LAB_INSTRUCTOR_PASSWORD,
    before.courseModuleId,
  );
  assert.equal(instructor.session.userId, before.instructor.userId);
  assert.equal(instructor.session.learner, false);
  assert.ok(instructor.session.roles.includes(INSTRUCTOR));
  assert.equal(instructor.session.current, null);
  assert.deepEqual(instructor.session.history, []);

  const checks = [];
  async function rejected(name, actor, route, status, code, extraBody = {}, changes = {}) {
    const headers = {
      "Content-Type": "application/json",
      "X-CSRF-Token": actor.session.csrf,
      Origin: TOOL,
      ...changes,
    };
    for (const key of Object.keys(headers)) {
      if (headers[key] === null) {
        delete headers[key];
      }
    }
    const body =
      route === "submit"
        ? { requestId: randomUUID(), answers: { q1: "rag", q2: "embedding", q3: "api" }, ...extraBody }
        : {};
    const response = await actor.client.request(`${TOOL}/api/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const received = await response.json();
    assert.equal(response.status, status, `Unexpected HTTP status for ${name}`);
    assert.equal(received.code, code, `Unexpected error code for ${name}`);
    const currentGrades = gradeSnapshot(await runMoodle("status"));
    const currentAttempts = await attemptDigests();
    assert.deepEqual(currentGrades, originalGrades, `Moodle grades changed after ${name}`);
    assert.deepEqual(currentAttempts, originalAttempts, `Attempt files changed after ${name}`);
    checks.push({
      name,
      actor: actor.session.userId,
      method: "POST",
      route: `/api/${route}`,
      expectedStatus: status,
      actualStatus: response.status,
      code: received.code,
      message: received.error,
      gradesUnchanged: true,
      attemptsUnchanged: true,
    });
  }

  await rejected("Подмена userId", learner, "submit", 400, "invalid_body", { userId: before.learners[0].userId });
  await rejected("Готовый scoreGiven из браузера", learner, "submit", 400, "invalid_body", { scoreGiven: 10 });
  await rejected("Отсутствует q3", learner, "submit", 400, "AnswersValidationError", {
    answers: { q1: "rag", q2: "embedding" },
  });
  await rejected("POST без CSRF", learner, "submit", 403, "invalid_csrf", {}, { "X-CSRF-Token": null });
  await rejected(
    "POST с неверным CSRF",
    learner,
    "submit",
    403,
    "invalid_csrf",
    {},
    { "X-CSRF-Token": "not-a-valid-token" },
  );
  await rejected("POST без Origin", learner, "submit", 403, "cross_origin", {}, { Origin: null });
  await rejected(
    "POST с чужим Origin",
    learner,
    "submit",
    403,
    "cross_origin",
    {},
    { Origin: "https://outside.example.invalid" },
  );
  await rejected("Instructor: отправка оценки", instructor, "submit", 403, "read_only");
  await rejected("Instructor: новая попытка", instructor, "new-attempt", 403, "read_only");
  const after = await runMoodle("status");
  return {
    checkedAt: new Date().toISOString(),
    evidenceBoundary:
      "Real local Moodle login and signed OIDC/LTI launches, normal ltijs server with MongoDB. HTTP protocol client, not mock JWTs or browser DevTools. Each rejection is followed by read-only Moodle queries and SHA-256 comparison of learner attempt files.",
    localOnly: true,
    httpsVerified: false,
    courseId: before.courseId,
    courseModuleId: before.courseModuleId,
    resourceId: before.resourceId,
    student: { userId: learner.session.userId, learner: learner.session.learner, roles: learner.session.roles },
    instructor: { ...before.instructor, learner: instructor.session.learner, roles: instructor.session.roles },
    checks,
    before: originalGrades,
    after: gradeSnapshot(after),
    attemptFileCount: originalAttempts.length,
    attemptFilesUnchanged: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2, "Usage: verify-local-lti.mjs");
    console.log(JSON.stringify(await verifyLiveLocalLti(), null, 2));
  } catch (error) {
    // Never print credentials, cookies, id_token, CSRF or recovery tokens.
    console.error(`Live local LTI verification failed: ${error.name}. No valid learner score is sent by this command.`);
    process.exitCode = 1;
  }
}
