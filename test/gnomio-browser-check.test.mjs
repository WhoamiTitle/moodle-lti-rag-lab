import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/verify-gnomio-browser.mjs", import.meta.url), "utf8");
const origin = "https://se.ifmo.ru";
const basePath = "/~s507353/moodle-lti-rag";
const csrf = "synthetic-private-csrf-never-print";

function session(userId) {
  const instructor = userId === "5";
  return {
    userId,
    learner: !instructor,
    roles: [`http://purl.imsglobal.org/vocab/lis/v2/membership#${instructor ? "Instructor" : "Learner"}`],
    platform: { issuer: "https://eoweblab.gnomio.com", clientId: "QDIIlIIQWNH3yro", deploymentId: "1" },
    demo: false,
    scoreMaximum: 10,
    courseTitle: "Test",
    resourceTitle: "RAG-рекомендательная система: три задания (LTI)",
    course: "2",
    resource: "6",
    csrf,
    current: instructor ? null : { scoreGiven: 0, scoreMaximum: 10, status: "sent", deliveries: 1 },
    history: [],
    historyTotal: 0,
  };
}

async function run({ userId = "5", location = {}, alterSession = (value) => value, alterPost } = {}) {
  const requests = [];
  const logs = [];
  const posts = [];
  const context = {
    location: { origin, pathname: `${basePath}/app`, search: "", ...location },
    crypto: { randomUUID: () => "9e117572-3e3d-40cb-8a02-000000000001" },
    AbortSignal,
    console: Object.fromEntries(["table", "info", "error"].map((name) => [name, (value) => logs.push(value)])),
    async fetch(url, options) {
      requests.push({ url, options });
      assert.ok(url.startsWith(`${origin}${basePath}/api/`));
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.mode, "same-origin");
      assert.equal(options.redirect, "error");
      if (!options.method) {
        return { status: 200, json: async () => alterSession(session(userId), posts.length) };
      }
      posts.push({ url, options });
      const body = JSON.parse(options.body);
      let result = { status: 403, code: "read_only" };
      if (userId === "4") {
        if (options.headers["X-CSRF-Token"] !== csrf) {
          result = { status: 403, code: "invalid_csrf" };
        } else if ("userId" in body || "scoreGiven" in body) {
          result = { status: 400, code: "invalid_body" };
        } else if (!("q3" in body.answers)) {
          result = { status: 400, code: "AnswersValidationError" };
        } else {
          assert.fail("A valid learner mutation must never be sent");
        }
      }
      result = alterPost ? alterPost(result) : result;
      return { status: result.status, json: async () => ({ code: result.code }) };
    },
  };
  // Run only our own static diagnostic source in a synthetic context; no browser or network access.
  await vm.runInNewContext(source, context, { timeout: 1000 });
  const summary = logs.filter((value) => typeof value === "string").at(-1);
  assert.ok(summary.startsWith("GNOMIO_NEGATIVE_CHECKS "));
  assert.ok(!JSON.stringify(logs).includes(csrf), "Private tokens must not appear in the output");
  return { requests, posts, report: JSON.parse(summary.slice("GNOMIO_NEGATIVE_CHECKS ".length)) };
}

test("manual browser check verifies both Instructor rejections without printing tokens", async () => {
  const { posts, report } = await run();
  assert.equal(report.ok, true);
  assert.equal(report.actor, "instructor1");
  assert.equal(report.role, "Instructor");
  assert.equal(posts.length, 2);
  assert.deepEqual(
    report.checks.map(({ actualStatus }) => actualStatus),
    [403, 403],
  );
  assert.ok(report.checks.every(({ attemptsUnchanged }) => attemptsUnchanged));
});

test("manual browser check sends only invalid learner submissions and never a new attempt", async () => {
  const { posts, report } = await run({ userId: "4" });
  assert.equal(report.ok, true);
  assert.equal(report.actor, "student2");
  assert.equal(posts.length, 5);
  assert.ok(posts.every(({ url }) => url.endsWith("/api/submit")));
  assert.deepEqual(
    report.checks.map(({ actualStatus }) => actualStatus),
    [400, 400, 400, 403, 403],
  );
});

test("manual browser check refuses other pages before any network request", async () => {
  for (const location of [
    { origin: "https://outside.example.invalid" },
    { pathname: `${basePath}/` },
    { search: "?x=1" },
  ]) {
    const { requests, report } = await run({ location });
    assert.equal(report.ok, false);
    assert.equal(requests.length, 0);
  }
});

test("manual browser check refuses administrators, student1 and unexpected registrations", async () => {
  for (const options of [
    { userId: "2" },
    { userId: "3" },
    {
      alterSession: (value) => ({
        ...value,
        platform: { ...value.platform, issuer: "https://outside.example.invalid" },
      }),
    },
    { alterSession: (value) => ({ ...value, roles: [] }) },
    { userId: "4", alterSession: (value) => ({ ...value, current: { ...value.current, scoreGiven: 7 } }) },
  ]) {
    const { posts, report } = await run(options);
    assert.equal(report.ok, false);
    assert.equal(posts.length, 0);
  }
});

test("manual browser check stops at the first unexpected status or changed attempt snapshot", async () => {
  for (const options of [
    { alterPost: () => ({ status: 200, code: "unexpected" }) },
    {
      userId: "4",
      alterSession: (value, count) => ({ ...value, current: { ...value.current, deliveries: count ? 2 : 1 } }),
    },
  ]) {
    const { posts, report } = await run(options);
    assert.equal(report.ok, false);
    assert.equal(posts.length, 1);
  }
});
