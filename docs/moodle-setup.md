# Подключение к Moodle / Gnomio

Эта инструкция — для удалённого Moodle/Gnomio. Публичный HTTPS-стенд размещён на Helios; его точные URL и команды — в [helios.md](helios.md). 11.10.2026 реальный Gnomio зарегистрирован: проверены запуск и оценки 0/7/10 для вымышленного `student1` через Moodle «Войти как», итог — 10; администратор с ролью Teacher получает только просмотр. После самостоятельного входа пользователя под `student1` новый запуск из курса восстановил 10/10 и историю 0/7, оценка в журнале сохранилась. Второй вымышленный `student2` вошёл обычным способом и получил 0/10; его история не показала попытки первого ученика. Настоящий Grader report подтвердил 10/0 в одной колонке, без ручной правки. Отдельный неадминистративный Instructor в Gnomio пока не проверен. [Протокол](gnomio-lti-evidence.json).

Настоящее **локальное** подключение Moodle 5.3 проверено отдельно с оценками 0/7/10 под двумя студентами и итогом А = 10 / Б = 7; его команды — в [local-lti.md](local-lti.md).

## 1. Поднять обычный сервер

1. Установить Node.js 24+ и зависимости `npm ci`.
2. Запустить MongoDB: например, `docker compose up -d mongo`.
3. Скопировать `.env.example` в `.env`, указать реальный `PUBLIC_URL`, например `https://trainer.example.org`; `MOODLE_*` пока пусты.
4. Настроить TLS reverse proxy до `127.0.0.1:3000`. Передавать GET/POST, не кешировать API/OIDC и не блокировать form-urlencoded callback. У proxy не сохранять query string `/session/start` в access log.
5. Запустить `npm start`. `/healthz` должен быть доступен снаружи с `configured:false`. Не открывать наружу MongoDB 27017.

Не публикуйте `npm run demo`: это имитация с вымышленными участниками. `file://` и localhost не подходят для удалённой регистрации.

## 2. Зарегистрировать LTI 1.3

Названия меню зависят от Moodle и прав доступа. У администратора: Site administration → Plugins → Activity modules → External tool → Manage tools → configure a tool manually. В некоторых версиях управление инструментами доступно и внутри курса.

| Поле Moodle                           | Значение для нашего сервера                                      |
| ------------------------------------- | ---------------------------------------------------------------- |
| Tool name                             | RAG-тренажёр: три задания                                        |
| LTI version                           | LTI 1.3                                                          |
| Tool URL                              | `https://trainer.example.org/lti/launch`                         |
| Initiate login URL                    | `https://trainer.example.org/lti/login`                          |
| Redirection URI(s)                    | `https://trainer.example.org/lti/launch`                         |
| Public key type                       | Keyset URL / JWKS URL                                            |
| Public keyset URL                     | `https://trainer.example.org/lti/keys`                           |
| Default launch container              | New window                                                       |
| IMS LTI Assignment and Grade Services | Use this service for grade sync only / разрешить передачу оценок |
| Names and Role Provisioning           | Не требуется                                                     |
| Deep Linking / content selection      | Не требуется                                                     |
| Share launcher's name                 | Never — для этого учебного стенда                                |
| Share launcher's email                | Never                                                            |
| Accept grades from tool               | Always / разрешить                                               |

`https://trainer.example.org` — заглушка: замените на реальный `PUBLIC_URL` во всех полях, включая подпапку, если она используется. Ключи проверки подписей публичные; приватные ключи из MongoDB никогда не вставляются в Moodle.

Если выбран поддерживаемый Moodle тип `RSA key`, `/tool-public-key` отдаёт публичный PEM **после** регистрации платформы на сервере. В поле public key вставляется текст `-----BEGIN PUBLIC KEY-----...`, не URL. Этот вариант проверен на локальном Moodle 5.3; совместимость со старым Moodle отдельно не проверялась. Основной сценарий удалённого подключения — JWKS.

## 3. Перенести реквизиты Moodle в .env

После сохранения инструмента Configuration details показывает реквизиты платформы:

| Реквизит Moodle             | Переменная сервера     |
| --------------------------- | ---------------------- |
| Platform ID / issuer        | `MOODLE_ISSUER`        |
| Client ID                   | `MOODLE_CLIENT_ID`     |
| Deployment ID               | `MOODLE_DEPLOYMENT_ID` |
| Authentication request URL  | `MOODLE_AUTH_URL`      |
| Access token URL            | `MOODLE_TOKEN_URL`     |
| Public keyset URL платформы | `MOODLE_JWKS_URL`      |

Копируйте точные значения, не выводите пути по имени сайта. JWKS Moodle — не `/lti/keys` нашего инструмента. Issuer чувствителен к отличиям строки, включая завершающий `/`. Заполните все шесть полей и перезапустите обычный сервер. Он создаст регистрацию и RSA-ключи в MongoDB; далее ключи сохраняются. `/healthz` станет `configured:true`; `/lti/keys` будет содержать публичный ключ инструмента.

Не присылайте `.env`, id_token, OAuth access token или приватные ключи в переписку. Client ID, deployment и публичные endpoint URL — регистрационные реквизиты, не пароль; в отчёт включайте лишь необходимые значения.

## 4. Добавить элемент курса

Edit mode → Add an activity or resource → External tool. Выбрать зарегистрированный инструмент; название: «RAG-рекомендательная система: три задания».

В проверенном Gnomio сначала нужно включить инструмент в курсе: More → LTI External tools →
Show in activity chooser. Затем в режиме редактирования выбрать Insert content → Activity or
resource → «RAG-тренажёр · Helios · LTI 1.3». Отсутствие общего пункта External tool в chooser
не означает, что LTI отключён.

- Launch container — New window.
- Grade type — Point / числовая оценка.
- Maximum grade — **10**.
- Разрешить принятие оценок.
- Сохранить и открыть через курс, не напрямую по `/app`.

Преподаватель запускает только просмотр. Для ответов нужен отдельный зачисленный ученик. Приложение не принимает роль из браузера и не создаёт учебных оценок преподавателю.

## 5. Проверить реальную передачу

1. Ученик A: пустые ответы → 0/10; проверить журнал курса.
2. A: «Новая попытка», `RAG / неверно / API` → 7/10. В той же колонке теперь 7.
3. A: новая попытка, `RAG / embedding / API` → 10/10. В той же колонке теперь 10; история содержит 0 и 7.
4. Ученик B: пустые ответы → 0/10. Оценка A остаётся 10; история B не содержит A.
5. Преподаватель: форма видна, отправка запрещена; его учебная оценка не появляется.

Нужны скриншоты тренажёра и **реального журнала курса**. «Доставлена» означает успешный HTTP-ответ AGS; итоговое отображение, масштабирование и политика оценивания конкретного Moodle проверяются в самой LMS.

## Если нет оценки

- `ags_unavailable`: включить AGS grade sync и принятие оценок; открыть элемент снова для нового launch с `scope/score` и `lineitem`.
- `deployment_not_allowed`: сверить issuer, client ID и deployment; перезапустить сервер после изменения `.env`.
- `pending / ags_http_401`: проверить ключи регистрации, client ID, token URL, часы сервера и разрешения. Не удалять попытку; после исправления повторить доставку.
- `ags_http_403`: у инструмента нет права на колонку/услугу; сверить External tool.
- `ags_http_400`: проверить колонку и контекст. Максимум тренажёра — 10; клиент не может задавать шкалу.
- `ags_network`: проверить доступ сервера к Moodle по HTTPS. Запрос мог уже быть принят — повтор отправляет те же баллы.
- `/app` без запуска возвращает 401: ожидаемо, открывать через курс.
- Iframe не открывается: выбрать New window.
- Заблокировано хранилище/истекла сессия: разрешить localStorage origin инструмента и запустить снова.
- `sent`, но другая оценка в журнале: проверить масштаб, overrides и политики журнала; не создавать вторую колонку обходным способом.

Не отключайте TLS, подпись, deployment, CSRF и проверку роли для устранения ошибки запуска.
