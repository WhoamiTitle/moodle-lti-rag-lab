import assert from "node:assert/strict";
import { createServer } from "node:net";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfig } from "../src/config.mjs";
import { createTool } from "../src/tool.mjs";
import { MemoryLtiDatabase } from "../test-support/memory-lti-database.mjs";
import {
  AGS_CLAIM,
  CLAIM,
  CLIENT_ID,
  DEPLOYMENT_ID,
  INSTRUCTOR,
  LEARNER,
  startMockPlatform,
} from "../test-support/mock-platform.mjs";

const silent = { warn() {}, error() {} };
const correct = { q1: "rag", q2: "embedding", q3: "api" };
const zero = { q1: "", q2: "", q3: "" };

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function fixture(t, { basePath = "" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rag-lti-test-"));
  const platform = await startMockPlatform();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}${basePath}`;
  const config = readConfig({
    PORT: String(port),
    PUBLIC_URL: url,
    DATA_DIR: directory,
    MOODLE_ISSUER: platform.origin,
    MOODLE_CLIENT_ID: CLIENT_ID,
    MOODLE_DEPLOYMENT_ID: DEPLOYMENT_ID,
    MOODLE_AUTH_URL: `${platform.origin}/auth`,
    MOODLE_TOKEN_URL: `${platform.origin}/token`,
    MOODLE_JWKS_URL: `${platform.origin}/jwks`,
  });
  platform.setToolUrl(url);
  const databaseManager = new MemoryLtiDatabase();
  const tool = createTool(config, { databaseManager, logger: silent });
  await tool.start();
  t.after(async () => {
    await tool.close();
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function initiate(subject = "student-a", overrides = {}, signingKey) {
    const query = new URLSearchParams({
      iss: platform.origin,
      client_id: CLIENT_ID,
      login_hint: subject,
      target_link_uri: `${url}/lti/launch`,
      lti_deployment_id: DEPLOYMENT_ID,
    });
    const login = await fetch(`${url}/lti/login?${query}`);
    assert.equal(login.status, 200);
    const html = await login.text();
    const data = JSON.parse(html.match(/id="ltijs-login-data">([\s\S]*?)<\/script>/)[1]);
    const launch = platform.createLaunch(data.targetUrl, overrides, signingKey);
    const body = { ...launch, ltijs_recovered_state: data.recoveryToken };
    return { launch, body, recoveryToken: data.recoveryToken, targetUrl: data.targetUrl };
  }
  async function callback(body) {
    return fetch(`${url}/lti/launch`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", Origin: origin },
      body: new URLSearchParams(body),
    });
  }
  async function launch(subject, overrides) {
    const initiated = await initiate(subject, overrides);
    const first = await callback(initiated.launch);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /ltijs_recovered_state/);
    const verified = await callback(initiated.body);
    assert.equal(verified.status, 302, await verified.clone().text());
    assert.ok(!verified.headers.get("location").includes("ltik"));
    const activationUrl = new URL(verified.headers.get("location"), url);
    const activation = await fetch(activationUrl, { redirect: "manual" });
    assert.equal(activation.status, 303);
    assert.equal(activation.headers.get("location"), `${basePath}/app`);
    const setCookie = activation.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.equal((await fetch(activationUrl, { redirect: "manual" })).status, 401);
    const cookie = setCookie.split(";")[0];
    const session = await fetch(`${url}/api/session`, { headers: { Cookie: cookie } }).then((response) =>
      response.json(),
    );
    return { cookie, session, initiated };
  }
  async function api(client, route, body, extraHeaders = {}) {
    const response = await fetch(`${url}/api/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: client.cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": client.session.csrf,
        ...(body === undefined ? {} : { Origin: origin }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { url, origin, platform, tool, config, databaseManager, launch, initiate, callback, api };
}

test("Подпапка HTTPS-стенда: LTI, assets, redirects, API, 0/7/10 и защита Origin сохраняют контракт", async (t) => {
  const { url, origin, platform, launch, initiate, api } = await fixture(t, {
    basePath: "/~s507353/moodle-lti-rag",
  });
  const canonical = await fetch(`${url}?x=1`, { redirect: "manual" });
  assert.equal(canonical.status, 308);
  assert.equal(canonical.headers.get("location"), "/~s507353/moodle-lti-rag/?x=1");
  const welcome = await fetch(`${url}/`).then((response) => response.text());
  assert.match(welcome, /href="\.\/assets\/app.css"/);
  assert.equal((await fetch(`${origin}/healthz`)).status, 404);
  for (const asset of ["app.css", "app.js", "api.js"]) {
    assert.equal((await fetch(`${url}/assets/${asset}`)).status, 200);
  }
  const initiation = await initiate();
  assert.equal(new URL(initiation.targetUrl).searchParams.get("redirect_uri"), `${url}/lti/launch`);
  assert.ok(initiation.recoveryToken);
  const a = await launch("student-a");
  const appPage = await fetch(`${url}/app`, { headers: { Cookie: a.cookie } });
  assert.equal(appPage.status, 200);
  assert.match(await appPage.text(), /src="\.\/assets\/app.js"/);
  assert.doesNotMatch(appPage.headers.get("content-security-policy"), /unsafe-inline/);
  const submission = { requestId: randomUUID(), answers: correct };
  assert.equal((await api(a, "submit", submission, { Origin: url })).status, 403);
  assert.equal((await api(a, "submit", submission, { Origin: "https://evil.example" })).status, 403);
  assert.equal(platform.scoreRequests.length, 0);
  for (const [index, answers] of [zero, { q1: "rag", q2: "wrong", q3: "api" }, correct].entries()) {
    const result = await api(a, "submit", { requestId: randomUUID(), answers });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.current.scoreGiven, [0, 7, 10][index]);
    if (index < 2) {
      assert.equal((await api(a, "new-attempt", {})).status, 200);
    }
  }
  const b = await launch("student-b");
  assert.equal(
    (await api(b, "submit", { requestId: randomUUID(), answers: { q1: "rag", q2: "", q3: "api" } })).status,
    200,
  );
  assert.equal(platform.grades.get("rag-link:student-a").scoreGiven, 10);
  assert.equal(platform.grades.get("rag-link:student-b").scoreGiven, 7);
  const teacher = await launch("instructor");
  assert.equal((await api(teacher, "submit", { requestId: randomUUID(), answers: correct })).status, 403);
});

test("Контракт стартера: GET /api/session возвращает идентичность, роли, задания и попытки", async (t) => {
  const { config, url, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const session = a.session;
  assert.equal(session.label, config.appLabel);
  assert.equal(session.userId, "student-a");
  assert.equal(session.name, "Студент A (тест)");
  assert.deepEqual(session.roles, [LEARNER]);
  assert.equal(session.course, "rag-course");
  assert.equal(session.resource, "rag-link");
  assert.equal(session.learner, true);
  assert.equal(session.agsReady, true);
  assert.ok(session.csrf);
  assert.equal(session.current, null);
  assert.deepEqual(session.history, []);
  assert.deepEqual(
    session.tasks.map(({ id, points }) => ({ id, points })),
    [
      { id: "q1", points: 3 },
      { id: "q2", points: 3 },
      { id: "q3", points: 4 },
    ],
  );
  for (const task of session.tasks) {
    assert.deepEqual(Object.keys(task).sort(), ["id", "points", "prompt"]);
  }
  // GET remains available with a valid session and no Origin header.
  assert.equal((await fetch(`${url}/api/session`, { headers: { Cookie: a.cookie } })).status, 200);
  const teacher = await launch("instructor");
  assert.equal(teacher.session.learner, false);
  assert.equal(teacher.session.agsReady, true);
  assert.equal((await api(teacher, "submit", { requestId: randomUUID(), answers: correct })).status, 403);
  const withoutAgs = await launch("student-a", { [AGS_CLAIM]: { scope: [] } });
  assert.equal(withoutAgs.session.learner, true);
  assert.equal(withoutAgs.session.agsReady, false);
});

test("Контракт стартера: POST /api/submit оборачивает результат в current и помечает подтверждённый повтор", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const body = { requestId: randomUUID(), answers: correct };
  const first = await api(a, "submit", body);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ["current", "ok"]);
  assert.equal(first.body.ok, true);
  const current = first.body.current;
  assert.equal(current.requestId, body.requestId);
  assert.match(current.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(current.answers, correct);
  assert.equal(current.answerSignature, JSON.stringify(["rag", "embedding", "api"]));
  assert.equal(current.scoreGiven, 10);
  assert.equal(current.scoreMaximum, 10);
  assert.equal(current.status, "sent");
  assert.ok(Number.isFinite(Date.parse(current.createdAt)));
  assert.ok(Number.isFinite(Date.parse(current.sentAt)));
  assert.equal(current.lastDeliveryAt, platform.scoreRequests[0].score.timestamp);
  assert.ok(!Object.hasOwn(current, "lineItemId"));
  assert.deepEqual((await api(a, "session")).body.current, current);
  const duplicate = await api(a, "submit", body);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.body, { ok: true, duplicate: true, current });
  assert.equal(platform.scoreRequests.length, 1);
});

test("Контракт стартера: неподтверждённый AGS возвращает 502, ok:false, current и понятную ошибку", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const body = { requestId: randomUUID(), answers: correct };
  platform.failNextScore();
  const pending = await api(a, "submit", body);
  assert.equal(pending.status, 502);
  assert.deepEqual(Object.keys(pending.body).sort(), ["current", "error", "ok"]);
  assert.equal(pending.body.ok, false);
  assert.match(pending.body.error, /Оценка сохранена.*Повторите отправку/);
  assert.equal(pending.body.current.requestId, body.requestId);
  assert.equal(pending.body.current.status, "pending");
  assert.equal(pending.body.current.sentAt, null);
  assert.equal(pending.body.current.scoreGiven, 10);
  assert.deepEqual(pending.body.current.answers, correct);
  const saved = (await api(a, "session")).body;
  assert.deepEqual(saved.current, pending.body.current);
  assert.deepEqual(saved.history, []);
  assert.equal((await api(a, "new-attempt", {})).status, 409);
  const retry = await api(a, "submit", body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.ok, true);
  assert.equal(retry.body.current.status, "sent");
  assert.equal(retry.body.current.id, pending.body.current.id);
  assert.equal(retry.body.current.requestId, body.requestId);
  assert.equal(platform.scoreRequests.length, 2);
  assert.equal(platform.acceptedEffects.length, 1);
});

test("Контракт стартера: POST /api/new-attempt возвращает только ok:true и архивирует завершённую попытку", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const empty = await api(a, "new-attempt", {});
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { ok: true });
  const body = { requestId: randomUUID(), answers: correct };
  await api(a, "submit", body);
  const next = await api(a, "new-attempt", {});
  assert.equal(next.status, 200);
  assert.deepEqual(next.body, { ok: true });
  const saved = (await api(a, "session")).body;
  assert.equal(saved.current, null);
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].requestId, body.requestId);
  assert.deepEqual(saved.history[0].answers, correct);
  assert.equal((await api(a, "new-attempt", { userId: "student-b" })).status, 400);
  assert.equal(platform.scoreRequests.length, 1);
});

test("Контракт стартера: оба POST требуют точный Origin даже с действительными сессией и CSRF", async (t) => {
  const { url, platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const body = { requestId: randomUUID(), answers: correct };
  const rejectedHeaders = [
    { Origin: "" },
    { Origin: "null" },
    { Origin: "https://evil.example" },
    { Origin: `${url}/` },
    { Origin: url, "Sec-Fetch-Site": "cross-site" },
  ];
  async function withoutOrigin(route, requestBody) {
    const response = await fetch(`${url}/api/${route}`, {
      method: "POST",
      headers: {
        Cookie: a.cookie,
        "Content-Type": "application/json",
        "X-CSRF-Token": a.session.csrf,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify(requestBody),
    });
    return response.status;
  }
  assert.equal(await withoutOrigin("submit", body), 403);
  for (const headers of rejectedHeaders) {
    assert.equal((await api(a, "submit", body, headers)).status, 403);
  }
  assert.equal(platform.scoreRequests.length, 0);
  assert.equal((await api(a, "session")).body.current, null);
  assert.equal((await api(a, "submit", body, { "Sec-Fetch-Site": "same-origin" })).status, 200);
  assert.equal(await withoutOrigin("new-attempt", {}), 403);
  for (const headers of rejectedHeaders) {
    assert.equal((await api(a, "new-attempt", {}, headers)).status, 403);
  }
  const unchanged = (await api(a, "session")).body;
  assert.equal(unchanged.current.requestId, body.requestId);
  assert.deepEqual(unchanged.history, []);
  assert.equal(platform.scoreRequests.length, 1);
  assert.equal((await api(a, "new-attempt", {})).status, 200);
});

test("Контракт стартера: ошибки валидации содержат читаемую строку error, без сохранения и AGS", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const rejected = await api(a, "submit", { requestId: randomUUID(), answers: correct, userId: "student-b" });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Допустимые поля запроса/);
  assert.equal(rejected.body.code, "invalid_body");
  assert.equal((await api(a, "session")).body.current, null);
  assert.equal(platform.scoreRequests.length, 0);
});

test("Контракт стартера: session.history содержит всю историю с ответами в порядке создания", async (t) => {
  const { launch, api } = await fixture(t);
  const a = await launch("student-a");
  const ids = [];
  for (let index = 0; index < 22; index += 1) {
    const requestId = randomUUID();
    ids.push(requestId);
    const result = await api(a, "submit", { requestId, answers: index % 2 ? correct : zero });
    assert.equal(result.status, 200);
    assert.equal((await api(a, "new-attempt", {})).status, 200);
  }
  const saved = (await api(a, "session")).body;
  assert.equal(saved.current, null);
  assert.equal(saved.history.length, 22);
  assert.deepEqual(
    saved.history.map(({ requestId }) => requestId),
    ids,
  );
  saved.history.forEach((attempt, index) => {
    assert.deepEqual(attempt.answers, index % 2 ? correct : zero);
    assert.equal(attempt.scoreGiven, index % 2 ? 10 : 0);
    assert.equal(attempt.status, "sent");
    assert.ok(!Object.hasOwn(attempt, "lineItemId"));
  });
  const b = await launch("student-b");
  assert.deepEqual(b.session.history, []);
});

test("Подписанный LTI → форма → OAuth JWT → AGS: 0/7/10, последняя оценка, история и изоляция A/B", async (t) => {
  const { url, platform, launch, api } = await fixture(t);
  assert.deepEqual(await fetch(`${url}/healthz`).then((response) => response.json()), { ok: true, configured: true });
  for (const route of ["/api/session", "/app"]) {
    assert.equal((await fetch(`${url}${route}`)).status, 401);
  }
  const a = await launch("student-a");
  assert.equal(a.session.userId, "student-a");
  assert.equal(a.session.learner, true);
  assert.equal(a.session.agsReady, true);
  assert.ok(a.session.tasks.every((task) => !Object.hasOwn(task, "answer")));
  const appPage = await fetch(`${url}/app`, { headers: { Cookie: a.cookie } });
  assert.equal(appPage.status, 200);
  assert.match(appPage.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.doesNotMatch(appPage.headers.get("content-security-policy"), /unsafe-inline/);
  let firstBody;
  for (const [index, answers] of [zero, { q1: " RAG ", q2: "wrong", q3: " API " }, correct].entries()) {
    const body = { requestId: randomUUID(), answers };
    firstBody ??= body;
    const result = await api(a, "submit", body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.current.scoreGiven, [0, 7, 10][index]);
    assert.equal(result.body.current.status, "sent");
    if (index < 2) {
      assert.equal((await api(a, "new-attempt", {})).status, 200);
    }
  }
  assert.equal(platform.grades.get("rag-link:student-a").scoreGiven, 10);
  const before = platform.scoreRequests.length;
  const archivedDuplicate = (await api(a, "submit", firstBody)).body;
  assert.equal(archivedDuplicate.ok, true);
  assert.equal(archivedDuplicate.duplicate, true);
  assert.equal(archivedDuplicate.current.scoreGiven, 0);
  assert.equal(platform.scoreRequests.length, before);
  assert.equal(platform.grades.get("rag-link:student-a").scoreGiven, 10);
  const aSnapshot = (await api(a, "session")).body;
  assert.equal(aSnapshot.current.scoreGiven, 10);
  assert.deepEqual(
    aSnapshot.history.map((entry) => entry.scoreGiven),
    [0, 7],
  );
  const b = await launch("student-b");
  assert.equal(b.session.current, null);
  await api(b, "submit", { requestId: randomUUID(), answers: zero });
  assert.equal(platform.grades.get("rag-link:student-b").scoreGiven, 0);
  assert.equal(platform.grades.get("rag-link:student-a").scoreGiven, 10);
  assert.ok(platform.scoreRequests.every((call) => call.url.includes("/scores?type_id=rag-lab")));
  assert.ok(
    platform.acceptedEffects.every(
      (score) =>
        score.scoreMaximum === 10 && score.activityProgress === "Completed" && score.gradingProgress === "FullyGraded",
    ),
  );
});

test("Нет CSRF, подмена userId/оценки, неверный ввод, преподаватель и неизвестная роль не вызывают AGS", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const body = { requestId: randomUUID(), answers: correct };
  assert.equal((await api(a, "submit", body, { "X-CSRF-Token": "" })).status, 403);
  assert.equal((await api(a, "submit", body, { Origin: "https://evil.example" })).status, 403);
  for (const extra of [{ userId: "student-b" }, { scoreGiven: 10 }, { lineItemId: "https://evil.example" }]) {
    assert.equal((await api(a, "submit", { ...body, ...extra })).status, 400);
  }
  assert.equal((await api(a, "submit", { ...body, answers: { ...correct, q3: ["api"] } })).status, 400);
  for (const roles of [
    [INSTRUCTOR],
    [INSTRUCTOR, LEARNER],
    ["http://purl.imsglobal.org/vocab/lis/v2/membership#NotLearner"],
  ]) {
    const viewer = await launch("instructor", { [`${CLAIM}roles`]: roles });
    assert.equal(viewer.session.learner, false);
    assert.equal((await api(viewer, "submit", body)).status, 403);
    assert.equal((await api(viewer, "new-attempt", {})).status, 403);
  }
  assert.equal(platform.scoreRequests.length, 0);
});

test("Login без client_id привязан к текущей регистрации; внешний redirect target отклонён", async (t) => {
  const { url, platform } = await fixture(t);
  const query = new URLSearchParams({
    iss: platform.origin,
    login_hint: "student-a",
    target_link_uri: `${url}/lti/launch`,
  });
  const response = await fetch(`${url}/lti/login?${query}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const data = JSON.parse(html.match(/id="ltijs-login-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(new URL(data.targetUrl).searchParams.get("client_id"), CLIENT_ID);
  query.set("target_link_uri", "https://evil.example/lti/launch");
  assert.equal((await fetch(`${url}/lti/login?${query}`)).status, 400);
  assert.equal(platform.scoreRequests.length, 0);
});

test("Неверная подпись, deployment, expiry и повтор nonce отклоняются; без AGS запуск только для просмотра", async (t) => {
  const { launch, initiate, callback, api } = await fixture(t);
  const foreignKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  for (const [overrides, signingKey, status] of [
    [{}, foreignKey, 500],
    [{ [`${CLAIM}deployment_id`]: "foreign-deployment" }, undefined, 403],
    [{ exp: Math.floor(Date.now() / 1000) - 60 }, undefined, 500],
  ]) {
    const initiation = await initiate("student-a", overrides, signingKey);
    const response = await callback(initiation.body);
    // The library maps some JWT verifier exceptions to 500; rejection, not a session, is essential.
    assert.equal(response.status, status, await response.clone().text());
    assert.equal(response.headers.get("location"), null);
  }
  const valid = await launch("student-a");
  assert.equal((await callback(valid.initiated.body)).status, 400);
  const withoutAgs = await launch("student-a", { [AGS_CLAIM]: { scope: [] } });
  assert.equal(withoutAgs.session.learner, true);
  assert.equal(withoutAgs.session.agsReady, false);
  assert.equal((await api(withoutAgs, "submit", { requestId: randomUUID(), answers: correct })).status, 409);
});

test("AGS 503 оставляет pending; повторные и одновременные запросы не создают новую попытку", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const body = { requestId: randomUUID(), answers: correct };
  platform.failNextScore();
  const pending = await api(a, "submit", body);
  assert.equal(pending.status, 502);
  assert.equal(pending.body.ok, false);
  assert.equal(pending.body.current.status, "pending");
  assert.equal(pending.body.current.lastError, "ags_http_503");
  assert.equal(platform.acceptedEffects.length, 0);
  assert.equal((await api(a, "new-attempt", {})).status, 409);
  assert.equal((await api(a, "submit", { requestId: randomUUID(), answers: correct })).status, 409);
  assert.equal((await api(a, "submit", { ...body, answers: zero })).status, 409);
  const secondSession = await launch("student-a");
  assert.equal(secondSession.session.current.requestId, body.requestId);
  const gate = platform.gateNextScore();
  const retry = api(a, "submit", body);
  await gate.entered;
  const overlapping = api(secondSession, "submit", body);
  gate.release();
  const results = await Promise.all([retry, overlapping]);
  assert.ok(results.every((entry) => entry.status === 200 && entry.body.ok && entry.body.current.deliveries === 2));
  assert.equal(results.filter((entry) => entry.body.duplicate).length, 1);
  assert.equal(platform.scoreRequests.length, 2);
  assert.equal(platform.acceptedEffects.length, 1);
  assert.ok(
    Date.parse(platform.scoreRequests[1].score.timestamp) > Date.parse(platform.scoreRequests[0].score.timestamp),
  );
});

test("Ответ AGS потерян после принятия: повторяет тот же результат, без обещания exactly-once", async (t) => {
  const { platform, launch, api } = await fixture(t);
  const a = await launch("student-a");
  const body = { requestId: randomUUID(), answers: { q1: "rag", q2: "", q3: "api" } };
  platform.loseNextScoreResponse();
  const uncertain = await api(a, "submit", body);
  assert.equal(uncertain.status, 502);
  assert.equal(uncertain.body.ok, false);
  assert.equal(uncertain.body.current.status, "pending");
  assert.equal(platform.acceptedEffects.length, 1);
  assert.equal(platform.grades.get("rag-link:student-a").scoreGiven, 7);
  const repeated = await api(a, "submit", body);
  assert.equal(repeated.body.ok, true);
  assert.equal(repeated.body.current.status, "sent");
  assert.equal(repeated.body.current.requestId, body.requestId);
  assert.equal(platform.acceptedEffects.length, 2);
  assert.equal(platform.grades.get("rag-link:student-a").scoreGiven, 7);
  assert.equal((await api(a, "session")).body.historyTotal, 0);
});
