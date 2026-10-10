const elements = Object.fromEntries([
  'connection', 'session-details', 'mode', 'notice', 'answer-form', 'tasks', 'submit', 'new-attempt',
  'score', 'delivery', 'item-results', 'attempt-meta', 'history-count', 'history-empty', 'history-wrapper', 'history-rows',
].map((id) => [id, document.getElementById(id)]));

let session;
let draft = null;
let draftKey;
let busy = false;
let expired = false;

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function notice(message, kind = '') {
  elements.notice.textContent = message;
  elements.notice.className = `lab__notice${kind ? ` lab__notice_${kind}` : ''}`;
}
function attemptCount(count) {
  const plural = new Intl.PluralRules('ru').select(count);
  return `${count} ${{ one: 'попытка', few: 'попытки', many: 'попыток', other: 'попытки' }[plural]}`;
}
function rememberDraft(value) {
  draft = value;
  try {
    if (value) sessionStorage.setItem(draftKey, JSON.stringify(value));
    else sessionStorage.removeItem(draftKey);
  } catch {
    // The form continues without storage; server-side history remains authoritative.
  }
}
function readDraft() {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey));
    if (value && typeof value.requestId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
      && session.tasks.every(({ id }) => typeof value.answers?.[id] === 'string'
        && value.answers[id].length <= session.maxAnswerLength)) return value;
  } catch { /* Storage may be disabled. */ }
  return null;
}
async function request(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? { Accept: 'application/json' }
      : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.message || 'Не удалось выполнить запрос.');
    error.status = response.status;
    throw error;
  }
  return value;
}
function answersFromForm() {
  const form = new FormData(elements['answer-form']);
  return Object.fromEntries(session.tasks.map(({ id }) => [id, String(form.get(id) || '')]));
}
function updateControls() {
  const frozen = busy || expired || !session?.canSubmit || Boolean(session?.current) || Boolean(draft);
  for (const input of elements.tasks.querySelectorAll('input')) input.disabled = frozen;
  elements.submit.disabled = busy || expired || !session?.canSubmit || session?.current?.status === 'sent';
  elements.submit.textContent = busy ? 'Проверка и доставка…'
    : session?.current?.status === 'pending' ? 'Повторить доставку оценки'
      : draft ? 'Повторить запрос этой попытки' : 'Проверить и отправить оценку';
  elements['new-attempt'].hidden = !session?.canSubmit || session?.current?.status !== 'sent';
  elements['new-attempt'].disabled = busy || expired;
}
function renderTasks() {
  elements.tasks.replaceChildren();
  session.tasks.forEach((task, index) => {
    const article = node('article', undefined, 'lab__task');
    const heading = node('div', undefined, 'lab__task-heading');
    const title = node('h3', `Задание ${index + 1}`);
    title.id = `${task.id}-title`;
    heading.append(title, node('span', `${task.points} балла`, 'lab__task-points'));
    const prompt = node('p', task.prompt, 'lab__task-prompt');
    prompt.id = `${task.id}-prompt`;
    const label = node('label', 'Ваш ответ', 'lab__label');
    label.htmlFor = task.id;
    const input = node('input', undefined, 'lab__input');
    input.type = 'text';
    input.id = task.id;
    input.name = task.id;
    input.maxLength = session.maxAnswerLength;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-describedby', prompt.id);
    input.value = session.current?.answers[task.id] ?? draft?.answers[task.id] ?? '';
    article.setAttribute('aria-labelledby', title.id);
    article.append(heading, prompt, label, input);
    elements.tasks.append(article);
  });
}
function renderSession() {
  document.title = session.appLabel;
  elements.connection.textContent = session.demo ? 'Тестовая платформа · LTI подтверждён' : 'LTI-запуск подтверждён';
  elements['session-details'].replaceChildren();
  for (const [label, value] of [['Участник', session.identity.name], ['Курс', session.context.title], ['Элемент', session.resource.title]]) {
    const pair = node('div');
    pair.append(node('dt', label), node('dd', value));
    elements['session-details'].append(pair);
  }
  elements.mode.textContent = `${session.isLearner ? 'Режим ученика' : 'Только просмотр'} · LTI user ID: ${session.identity.id}. Это идентификатор из запуска, не обязательно логин Moodle.${session.demo ? ' Локальная имитация Moodle: оценки не отправляются в Gnomio.' : ''}`;
  const current = session.current;
  elements.score.textContent = current ? String(current.scoreGiven) : '—';
  elements.delivery.textContent = current?.status === 'sent' ? `${session.demo ? 'Тестовый журнал' : 'Moodle'} подтвердил приём оценки.`
    : current?.status === 'pending' ? 'Результат сохранён, доставка не подтверждена.' : 'Появится после проверки ответов.';
  elements['item-results'].replaceChildren();
  for (const item of current?.items || []) {
    const row = node('li');
    const task = session.tasks.find(({ id }) => id === item.id);
    row.append(node('span', `${item.id.toUpperCase()} · ${item.correct ? 'верно' : 'неверно'}`),
      node('span', `${item.points} / ${task.points}`));
    elements['item-results'].append(row);
  }
  elements['attempt-meta'].textContent = current ? `Запросов доставки: ${current.deliveries}. ${current.lastError || ''}` : '';
  elements['history-count'].textContent = attemptCount(session.historyTotal);
  elements['history-empty'].hidden = session.history.length > 0;
  elements['history-wrapper'].hidden = session.history.length === 0;
  elements['history-rows'].replaceChildren();
  for (const attempt of session.history) {
    const row = node('tr');
    row.append(node('td', new Date(attempt.createdAt).toLocaleString('ru-RU')),
      node('td', `${attempt.scoreGiven} / ${attempt.scoreMaximum}`), node('td', 'Подтверждена'));
    elements['history-rows'].append(row);
  }
  if (!session.isLearner) notice('Режим преподавателя/наблюдателя: задания доступны для просмотра, отправка оценки отключена.');
  else if (session.gradeUnavailable) notice(session.gradeUnavailable, 'error');
  else if (current?.status === 'pending') notice('Оценка сохранена. Повторите доставку; ответы и баллы останутся теми же. Новая попытка пока недоступна.');
  else if (current?.status === 'sent') notice('Оценка доставлена. Можно начать новую попытку — её результат обновит эту же колонку Moodle.', 'success');
  else if (draft) notice('Подтверждение предыдущего запроса не получено. Повторите его с тем же идентификатором и ответами.');
  else notice('Введите три ответа. После проверки тренажёр сохранит попытку и отправит итоговую оценку.');
  updateControls();
}
async function refresh() {
  session = await request('/api/session');
  draftKey = `rag-draft-v1:${JSON.stringify([session.platform.issuer, session.platform.clientId, session.platform.deploymentId,
    session.identity.id, session.context.id, session.resource.id])}`;
  draft = readDraft();
  if (session.current) rememberDraft(null);
  renderTasks();
  renderSession();
}
function handleError(error, ambiguous = false) {
  if (error.status === 401) {
    expired = true;
    elements.connection.textContent = 'Нужен новый запуск из Moodle';
  }
  notice(ambiguous && !error.status
    ? 'Связь с тренажёром прервалась. Неизвестно, принят ли запрос. Повторите его; идентификатор и ответы сохранены.'
    : error.message || 'Не удалось связаться с тренажёром.', 'error');
  updateControls();
  elements.notice.focus();
}

elements['answer-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || expired || !session?.canSubmit || session.current?.status === 'sent') return;
  if (!draft) rememberDraft(session.current
    ? { requestId: session.current.requestId, answers: session.current.answers }
    : { requestId: crypto.randomUUID(), answers: answersFromForm() });
  busy = true;
  notice('Попытка проверяется, результат отправляется в журнал…');
  updateControls();
  try {
    session.current = await request('/api/submit', draft);
    rememberDraft(null);
    renderTasks();
    renderSession();
    await refresh();
  } catch (error) {
    handleError(error, true);
  } finally {
    busy = false;
    updateControls();
  }
});
elements['new-attempt'].addEventListener('click', async () => {
  if (busy || expired || !session?.canSubmit) return;
  busy = true;
  updateControls();
  try {
    await request('/api/new-attempt', {});
    session.current = null;
    rememberDraft(null);
    renderTasks();
    await refresh();
    document.getElementById('q1').focus();
  } catch (error) { handleError(error); }
  finally { busy = false; updateControls(); }
});

refresh().catch(handleError);
