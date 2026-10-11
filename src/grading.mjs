// These definitions belong on the server. Use getPublicTasks() when sending
// questions to a browser: it omits the reference answers.
export const tasks = Object.freeze([
  Object.freeze({
    id: "q1",
    prompt:
      "Ассистент интернет-магазина сначала извлекает релевантные фрагменты описаний товаров из базы знаний, затем передаёт их языковой модели для генерации ответа покупателю. Как называется этот подход? Введите общепринятую аббревиатуру из трёх латинских букв.",
    answer: "rag",
    points: 3,
  }),
  Object.freeze({
    id: "q2",
    prompt:
      "Для семантического поиска модель преобразует запрос покупателя в плотный числовой вектор, который сравнивается с векторами фрагментов базы знаний. Как называется такое векторное представление? Введите английский термин в единственном числе.",
    answer: "embedding",
    points: 3,
  }),
  Object.freeze({
    id: "q3",
    prompt:
      "Перед рекомендацией товара нужно подтвердить его текущую цену и наличие. Доступны три источника: LLM — память языковой модели; INDEX — векторный индекс, обновлённый вчера; API — ответ информационной системы магазина с ценой и остатком на текущий момент. Какой источник следует использовать для этой проверки? Введите одно обозначение: LLM, INDEX или API.",
    answer: "api",
    points: 4,
  }),
]);

export const MAX_ANSWER_LENGTH = 200;

export class AnswersValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnswersValidationError";
    this.status = 400;
  }
}

export function normalize(value) {
  return value.trim().toLowerCase();
}

export function getPublicTasks() {
  return tasks.map(({ id, prompt, points }) => ({ id, prompt, points }));
}

function validateAnswers(answers) {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new AnswersValidationError("Ответы должны быть объектом с ключами q1, q2, q3.");
  }

  const answerKeys = Object.keys(answers);
  const taskIds = tasks.map(({ id }) => id);
  if (answerKeys.length !== taskIds.length || answerKeys.some((id) => !taskIds.includes(id))) {
    throw new AnswersValidationError("Нужны ровно три ключа: q1, q2, q3.");
  }

  for (const { id } of tasks) {
    if (typeof answers[id] !== "string") {
      throw new AnswersValidationError(`Ответ ${id} должен быть строкой.`);
    }
    if (answers[id].length > MAX_ANSWER_LENGTH) {
      throw new AnswersValidationError(`Ответ ${id} не должен превышать ${MAX_ANSWER_LENGTH} символов.`);
    }
  }
}

export function grade(answers) {
  validateAnswers(answers);

  const items = tasks.map((task) => {
    const correct = normalize(answers[task.id]) === normalize(task.answer);
    return { id: task.id, correct, points: correct ? task.points : 0 };
  });

  return {
    items,
    scoreGiven: items.reduce((sum, item) => sum + item.points, 0),
    scoreMaximum: tasks.reduce((sum, task) => sum + task.points, 0),
  };
}
