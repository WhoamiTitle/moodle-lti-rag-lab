export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function requireObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new AppError(400, 'invalid_body', `Допустимые поля запроса: ${keys.join(', ') || 'пустой объект'}.`);
  }
}
