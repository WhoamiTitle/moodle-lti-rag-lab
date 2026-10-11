import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalUrl, parseForm } from "../scripts/verify-local-lti.mjs";

test("live protocol form parser handles Moodle HTML entities without executing any script", () => {
  const form = parseForm(
    `<form id="ltiAuthForm" action="http://localhost:3000/lti/launch" method="post">
    <input type="hidden" name="state" value="synthetic&amp;value&#x2D;only&#45;test">
    <input name="id_token" value='synthetic&quot;token'>
    <script>throw new Error('must never execute');</script></form>`,
    "ltiAuthForm",
  );
  assert.equal(form.action, "http://localhost:3000/lti/launch");
  assert.equal(form.parameters.get("state"), "synthetic&value-only-test");
  assert.equal(form.parameters.get("id_token"), 'synthetic"token');
});

test("live protocol parser rejects ambiguous forms, duplicate fields and non-POST forms", () => {
  assert.throws(() => parseForm('<form method="post"></form><form method="post"></form>'), /exactly one/);
  assert.throws(() => parseForm('<form method="get"></form>'), /POST protocol form/);
  assert.throws(() => parseForm('<form method="post"><input name="state"><input name="state"></form>'), /Duplicate/);
});

test("live protocol client only accepts the two exact loopback origins, including redirects", () => {
  assert.equal(assertLocalUrl("/api/session", "http://localhost:3000").href, "http://localhost:3000/api/session");
  assert.equal(
    assertLocalUrl("http://localhost:8000/mod/lti/auth.php?state=synthetic").origin,
    "http://localhost:8000",
  );
  for (const url of [
    "https://moodle.example/",
    "http://127.0.0.1:8000/",
    "http://localhost:3001/",
    "http://localhost:8000@outside.example/",
    "http://synthetic@localhost:8000/",
    "http://localhost:3000/#fragment",
  ]) {
    assert.throws(() => assertLocalUrl(url), /Non-local/);
  }
});
