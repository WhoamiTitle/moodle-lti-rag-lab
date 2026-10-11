// Paste this entire file into DevTools Console on the Helios /app page after a real Moodle launch.
// No passwords, cookies or CSRF tokens are printed or copied. Nothing is sent outside this tool.
// Only synthetic student2 (4) and instructor1 (5) are allowed. Stop on the first unexpected result.
// Origin headers are browser-controlled: missing/foreign Origin is NOT tested by this script.
(async () => {
  const prefix = "GNOMIO_NEGATIVE_CHECKS";
  const origin = "https://se.ifmo.ru";
  const basePath = "/~s507353/moodle-lti-rag";
  const membership = "http://purl.imsglobal.org/vocab/lis/v2/membership#";
  let phase = "page guard";
  const checks = [];
  function requireCondition(condition) {
    if (!condition) {
      throw new Error("Safety guard failed");
    }
  }
  function validateSession(session) {
    requireCondition(
      session.platform?.issuer === "https://eoweblab.gnomio.com" &&
        session.platform.clientId === "QDIIlIIQWNH3yro" &&
        session.platform.deploymentId === "1" &&
        session.demo === false &&
        session.scoreMaximum === 10 &&
        session.courseTitle === "Test" &&
        session.resourceTitle === "RAG-рекомендательная система: три задания (LTI)",
    );
    const instructor = session.userId === "5" && session.learner === false;
    const learner = session.userId === "4" && session.learner === true;
    requireCondition(instructor || learner);
    requireCondition(session.roles?.includes(`${membership}${instructor ? "Instructor" : "Learner"}`));
    requireCondition(typeof session.csrf === "string" && session.csrf.length > 0);
    requireCondition(Array.isArray(session.history) && session.history.length === 0 && session.historyTotal === 0);
    requireCondition(
      instructor
        ? session.current === null
        : session.current?.scoreGiven === 0 && session.current.scoreMaximum === 10 && session.current.status === "sent",
    );
    return session;
  }
  function fingerprint(session) {
    const { userId, learner, roles, platform, course, resource, current, history, historyTotal } = session;
    return JSON.stringify({ userId, learner, roles, platform, course, resource, current, history, historyTotal });
  }
  async function request(route, options = {}) {
    return fetch(`${origin}${basePath}/api/${route}`, {
      ...options,
      credentials: "same-origin",
      mode: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  }
  async function readSession() {
    const response = await request("session");
    requireCondition(response.status === 200);
    return validateSession(await response.json());
  }
  try {
    requireCondition(
      globalThis.location?.origin === origin &&
        globalThis.location.pathname === `${basePath}/app` &&
        globalThis.location.search === "",
    );
    phase = "session guard";
    const original = await readSession();
    const originalFingerprint = fingerprint(original);
    const instructor = original.userId === "5";
    const cases = instructor
      ? [
          { name: "Instructor: submit", route: "submit", status: 403, code: "read_only" },
          { name: "Instructor: new attempt", route: "new-attempt", status: 403, code: "read_only" },
        ]
      : [
          { name: "Extra userId", status: 400, code: "invalid_body", extra: { userId: "3" } },
          { name: "Extra scoreGiven", status: 400, code: "invalid_body", extra: { scoreGiven: 10 } },
          { name: "Missing q3", status: 400, code: "AnswersValidationError", extra: { answers: { q1: "", q2: "" } } },
          { name: "Missing CSRF", status: 403, code: "invalid_csrf", csrf: null },
          { name: "Wrong CSRF", status: 403, code: "invalid_csrf", csrf: "not-a-valid-token" },
        ];
    for (const check of cases) {
      phase = check.name;
      const route = check.route || "submit";
      const headers = { "Content-Type": "application/json" };
      if (check.csrf !== null) {
        headers["X-CSRF-Token"] = check.csrf ?? original.csrf;
      }
      const body =
        route === "new-attempt"
          ? {}
          : { requestId: crypto.randomUUID(), answers: { q1: "", q2: "", q3: "" }, ...check.extra };
      const response = await request(route, { method: "POST", headers, body: JSON.stringify(body) });
      const received = await response.json();
      const unchanged = fingerprint(await readSession()) === originalFingerprint;
      checks.push({
        name: check.name,
        expectedStatus: check.status,
        actualStatus: response.status,
        code: received.code === check.code ? check.code : "unexpected",
        attemptsUnchanged: unchanged,
      });
      requireCondition(response.status === check.status && received.code === check.code && unchanged);
    }
    console.table(checks);
    console.info(
      `${prefix} ${JSON.stringify({
        ok: true,
        checkedAt: new Date().toISOString(),
        actor: instructor ? "instructor1" : "student2",
        technicalUserId: original.userId,
        role: instructor ? "Instructor" : "Learner",
        realGnomioSession: true,
        checks,
        evidenceBoundary:
          "Browser POST and API snapshot only; verify receiver grades and attempt file digests separately.",
      })}`,
    );
  } catch {
    console.error(`${prefix} ${JSON.stringify({ ok: false, stoppedAt: phase, checks })}`);
  }
})();
