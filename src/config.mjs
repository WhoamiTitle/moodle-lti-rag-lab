import path from 'node:path';

const MOODLE_FIELDS = [
  'MOODLE_ISSUER', 'MOODLE_CLIENT_ID', 'MOODLE_DEPLOYMENT_ID',
  'MOODLE_AUTH_URL', 'MOODLE_TOKEN_URL', 'MOODLE_JWKS_URL',
];

export function isLoopbackUrl(url) {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function checkUrl(value, name, { local = false, originOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}: требуется полный URL.`);
  }
  if (url.username || url.password || url.hash
    || (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && isLoopbackUrl(url)))) {
    throw new Error(`${name}: нужен HTTPS без пароля и фрагмента; HTTP допустим только на loopback.`);
  }
  if (originOnly && (url.pathname !== '/' || url.search)) {
    throw new Error(`${name}: укажите только origin, без пути и query string.`);
  }
  return originOnly ? url.origin : value;
}

export function readConfig(env = process.env, directory = process.cwd()) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT: число от 1 до 65535.');
  const publicUrl = checkUrl(env.PUBLIC_URL || `http://127.0.0.1:${port}`, 'PUBLIC_URL', {
    local: true, originOnly: true,
  });
  const local = isLoopbackUrl(new URL(publicUrl));
  const values = Object.fromEntries(MOODLE_FIELDS.map((key) => [key, env[key]?.trim() || '']));
  const configured = MOODLE_FIELDS.every((key) => values[key]);
  if (MOODLE_FIELDS.some((key) => values[key]) && !configured) {
    throw new Error(`Заполните все реквизиты Moodle или оставьте все пустыми: ${MOODLE_FIELDS.filter((key) => !values[key]).join(', ')}.`);
  }
  if (configured) {
    for (const key of ['MOODLE_ISSUER', 'MOODLE_AUTH_URL', 'MOODLE_TOKEN_URL', 'MOODLE_JWKS_URL']) {
      checkUrl(values[key], key, { local });
    }
  }
  const host = env.LISTEN_HOST || '127.0.0.1';
  if (local && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('При локальном PUBLIC_URL LISTEN_HOST должен быть loopback.');
  }
  return {
    port,
    host,
    publicUrl,
    appLabel: env.APP_LABEL || 'RAG · Учебный тренажёр',
    mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27017/moodle_lti_rag_lab',
    dataDir: path.resolve(directory, env.DATA_DIR || 'data/attempts'),
    sessionTtlMs: 45 * 60 * 1000,
    requestTimeoutMs: 15_000,
    configured,
    moodle: configured ? {
      issuer: values.MOODLE_ISSUER,
      clientId: values.MOODLE_CLIENT_ID,
      deploymentId: values.MOODLE_DEPLOYMENT_ID,
      authUrl: values.MOODLE_AUTH_URL,
      tokenUrl: values.MOODLE_TOKEN_URL,
      jwksUrl: values.MOODLE_JWKS_URL,
    } : null,
  };
}
