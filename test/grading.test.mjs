import assert from 'node:assert/strict';
import test from 'node:test';
import { AnswersValidationError, getPublicTasks, grade } from '../src/grading.mjs';

test('Все неверные и все пустые ответы дают 0/10', () => {
  for (const answers of [
    { q1: '__wrong__', q2: '__wrong__', q3: '__wrong__' },
    { q1: '', q2: '', q3: '' },
  ]) {
    const result = grade(answers);
    assert.equal(result.scoreGiven, 0);
    assert.equal(result.scoreMaximum, 10);
    assert.ok(result.items.every((item) => !item.correct));
  }
});

test('Правильные ответы RAG, embedding и API дают 10/10 с весами 3/3/4', () => {
  assert.deepEqual(grade({ q1: 'rag', q2: 'embedding', q3: 'api' }), {
    items: [
      { id: 'q1', correct: true, points: 3 },
      { id: 'q2', correct: true, points: 3 },
      { id: 'q3', correct: true, points: 4 },
    ],
    scoreGiven: 10,
    scoreMaximum: 10,
  });
});

test('Правильные q1 и q3 при неверном q2 дают 7/10', () => {
  const result = grade({ q1: 'rag', q2: '__wrong__', q3: 'api' });
  assert.equal(result.scoreGiven, 7);
  assert.equal(result.scoreMaximum, 10);
});

test('Пробелы по краям и регистр игнорируются', () => {
  const result = grade({ q1: ' RAG ', q2: '\tEmBeDdInG\n', q3: ' API ' });
  assert.equal(result.scoreGiven, 10);
});

test('Вчерашний INDEX не засчитывается как источник текущей цены и наличия', () => {
  const result = grade({ q1: 'rag', q2: 'embedding', q3: 'INDEX' });
  assert.equal(result.scoreGiven, 6);
  assert.deepEqual(result.items[2], { id: 'q3', correct: false, points: 0 });
});

test('Некорректная структура ответов отклоняется с признаком HTTP 400', () => {
  for (const answers of [
    null,
    [],
    'rag',
    { q1: 'rag', q2: 'embedding' },
    { q1: 'rag', q2: 'embedding', q3: 'api', scoreGiven: 10 },
    { q1: 'rag', q2: 'embedding', q3: 'api', userId: 'someone-else' },
    { q1: 'rag', q2: ['embedding'], q3: 'api' },
  ]) {
    assert.throws(() => grade(answers), (error) => {
      assert.ok(error instanceof AnswersValidationError);
      assert.equal(error.status, 400);
      return true;
    });
  }
});

test('Ответы до 200 символов разрешены, более длинные отклоняются', () => {
  assert.equal(grade({ q1: 'x'.repeat(200), q2: '', q3: '' }).scoreGiven, 0);
  assert.throws(
    () => grade({ q1: 'x'.repeat(201), q2: '', q3: '' }),
    AnswersValidationError,
  );
});

test('Публичные задания содержат формулировки и баллы, но не эталонные ответы', () => {
  const publicTasks = getPublicTasks();
  assert.deepEqual(publicTasks.map(({ id, points }) => ({ id, points })), [
    { id: 'q1', points: 3 },
    { id: 'q2', points: 3 },
    { id: 'q3', points: 4 },
  ]);
  for (const task of publicTasks) {
    assert.deepEqual(Object.keys(task).sort(), ['id', 'points', 'prompt']);
    assert.ok(task.prompt.length > 0);
  }
});
