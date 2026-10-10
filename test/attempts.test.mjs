import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AttemptStore, scopeKey } from '../src/attempt-store.mjs';
import { Attempts } from '../src/attempts.mjs';

const scope = { issuer: 'https://moodle.example', clientId: 'client', deploymentId: 'dep', userId: 'A', contextId: 'course', resourceLinkId: 'link' };
const correct = { q1: 'rag', q2: 'embedding', q3: 'api' };
const silent = { warn() {} };

async function fixture(t, options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rag-attempts-test-'));
  const store = new AttemptStore(directory);
  await store.init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, attempts: new Attempts(store, { logger: silent, ...options }), directory };
}

test('Попытка и timestamp записаны на диск до внешнего эффекта', async (t) => {
  const { attempts, directory } = await fixture(t);
  const requestId = randomUUID();
  const outcome = await attempts.submit(scope, { requestId, answers: correct }, 'https://moodle.example/lineitem', async (score) => {
    const state = JSON.parse(await readFile(path.join(directory, `${scopeKey(scope)}.json`), 'utf8'));
    assert.equal(state.current.requestId, requestId);
    assert.equal(state.current.status, 'pending');
    assert.equal(state.current.deliveries, 1);
    assert.equal(state.current.scoreGiven, 10);
    assert.equal(state.current.deliveryTimestamp, score.timestamp);
    assert.equal(score.userId, 'A');
  });
  assert.equal(outcome.status, 'sent');
  assert.ok(outcome.sentAt);
});

test('Подтверждённый requestId не доставляется повторно даже из истории; изменённые ответы отклоняются', async (t) => {
  const { attempts } = await fixture(t);
  const body = { requestId: randomUUID(), answers: correct };
  let calls = 0;
  const deliver = async () => { calls += 1; };
  await attempts.submit(scope, body, 'lineitem', deliver);
  await attempts.submit(scope, body, 'lineitem', deliver);
  await attempts.newAttempt(scope);
  await attempts.submit(scope, { requestId: randomUUID(), answers: { q1: '', q2: '', q3: '' } }, 'lineitem', deliver);
  const duplicate = await attempts.submit(scope, body, 'lineitem', deliver);
  assert.equal(duplicate.scoreGiven, 10);
  assert.equal(calls, 2);
  assert.equal((await attempts.snapshot(scope)).current.scoreGiven, 0);
  await assert.rejects(attempts.submit(scope, { ...body, answers: { ...correct, q3: '' } }, 'lineitem', deliver), { status: 409, code: 'request_id_reused' });
});

test('Pending переживает перезапуск; новая попытка и другая колонка заблокированы; timestamp возрастает при откате часов', async (t) => {
  let now = 200_000;
  const { attempts, store, directory } = await fixture(t, { clock: () => now });
  const body = { requestId: randomUUID(), answers: { q1: 'rag', q2: '', q3: 'api' } };
  const lineItem = 'https://moodle.example/lineitem';
  const first = await attempts.submit(scope, body, lineItem, async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); });
  assert.equal(first.status, 'pending');
  assert.equal(first.scoreGiven, 7);
  await assert.rejects(attempts.newAttempt(scope), { status: 409, code: 'delivery_pending' });
  await assert.rejects(attempts.submit(scope, body, 'https://moodle.example/other', async () => {}), { code: 'line_item_changed' });
  await store.close();
  const restarted = new AttemptStore(directory);
  await restarted.init();
  try {
    const service = new Attempts(restarted, { clock: () => now, logger: silent });
    now = 100_000;
    let delivered;
    const result = await service.submit(scope, body, lineItem, async (score) => { delivered = score; });
    assert.equal(result.status, 'sent');
    assert.equal(result.deliveries, 2);
    assert.equal(result.scoreGiven, 7);
    assert.equal(Date.parse(delivered.timestamp), 200_001);
    await service.newAttempt(scope);
    await service.submit(scope, { requestId: randomUUID(), answers: correct }, lineItem, async (score) => {
      assert.equal(Date.parse(score.timestamp), 200_002);
    });
  } finally {
    await restarted.close();
  }
});

test('Хранилище изолирует пользователя, регистрацию, deployment, курс и resource link', async (t) => {
  const { attempts } = await fixture(t);
  await attempts.submit(scope, { requestId: randomUUID(), answers: correct }, 'line', async () => {});
  for (const field of Object.keys(scope)) {
    const different = { ...scope, [field]: `other-${scope[field]}` };
    assert.notEqual(scopeKey(scope), scopeKey(different));
    assert.deepEqual(await attempts.snapshot(different), { current: null, history: [], historyTotal: 0 });
  }
});

test('Один каталог нельзя одновременно открыть двумя процессами/экземплярами', async (t) => {
  const { directory } = await fixture(t);
  const second = new AttemptStore(directory);
  await assert.rejects(second.init(), /Разрешён один процесс/);
});

test('Неуспешное локальное сохранение предотвращает AGS-вызов', async () => {
  let calls = 0;
  const service = new Attempts({
    run: (_scope, operation) => operation(),
    load: async () => ({ current: null, history: [], lastTimestamp: 0 }),
    save: async () => { throw new Error('Disk full'); },
  });
  await assert.rejects(service.submit(scope, { requestId: randomUUID(), answers: correct }, 'line', async () => { calls += 1; }), /Disk full/);
  assert.equal(calls, 0);
});
