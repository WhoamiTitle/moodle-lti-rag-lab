// Read-only/synthetic negative checks; never launches a user or submits a grade.
import assert from "node:assert/strict";

const publicUrl = "https://se.ifmo.ru/~s507353/moodle-lti-rag";
const checks = [];
async function check(route, status, options = {}) {
  const response = await fetch(`${publicUrl}${route}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  assert.equal(response.status, status, `${options.method || "GET"} ${route}`);
  const body = await response.text();
  checks.push({
    method: options.method || "GET",
    route,
    status: response.status,
    contentType: response.headers.get("content-type"),
    ...(response.headers.get("location") ? { location: response.headers.get("location") } : {}),
  });
  return { response, body };
}
const health = await check("/healthz", 200);
const status = JSON.parse(health.body);
assert.equal(status.ok, true);
assert.equal(typeof status.configured, "boolean");
const welcome = await check("/", 200);
assert.match(welcome.body, /Тренажёр запускается из Moodle/);
assert.match(welcome.body, /href="\.\/assets\/app.css"/);
assert.match(welcome.response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
for (const asset of ["app.css", "app.js", "api.js"]) {
  await check(`/assets/${asset}`, 200);
}
const keys = await check("/lti/keys", 200);
assert.ok(Array.isArray(JSON.parse(keys.body).keys));
await check("/app", 401);
await check("/api/session", 401);
const appRedirect = await check("/app/", 308);
assert.equal(appRedirect.response.headers.get("location"), "/~s507353/moodle-lti-rag/app");
await check("/lti/login", status.configured ? 400 : 503, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "login_hint=synthetic",
});
await check("/lti/login", 400, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{malformed",
});
for (const route of ["/package.json", "/src/config.mjs", "/data/attempts", "/not-found"]) {
  await check(route, 404);
}
await check("/healthz", 405, { method: "DELETE" });
console.log(
  JSON.stringify(
    { checkedAt: new Date().toISOString(), timezone: "Asia/Yakutsk", publicUrl, health: status, checks },
    null,
    2,
  ),
);
