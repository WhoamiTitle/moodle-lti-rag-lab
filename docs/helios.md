# LTI-тренажёр на Helios без Cloudflare

Публичный вход: <https://se.ifmo.ru/~s507353/moodle-lti-rag/>.
Это обычный HTTPS-адрес существующего сайта Helios, не туннель и не временный домен.

## Схема

```text
Браузер / Moodle → HTTPS se.ifmo.ru → Apache/PHP в public_html/moodle-lti-rag
                                         ↓ фиксированный HTTP 127.0.0.1:30353
                                      Node.js / ltijs
                                         ↓ приватный Unix-сокет
                                      MongoDB
```

Публичный каталог содержит только `.htaccess` и `index.php` — небольшой транспортный шлюз.
Он не вычисляет оценки, не хранит ключи и не принимает адрес backend из запроса.
Приложение, npm-зависимости, конфигурация, MongoDB, журнал и попытки находятся в
`/home/studs/s507353/.moodle-lti-rag`, вне `public_html`. Корневой приватный каталог имеет права
`700`, конфигурация — `600`, MongoDB-сокет — `700`. MongoDB не слушает TCP.

Использованы приватно распакованные официальные FreeBSD-пакеты Node.js 24.21.0 и MongoDB 8.0.29.
Системные пакеты, Apache/nginx и сайт портфолио не заменялись. Пакеты и их версии перечислены в
`deploy/helios/freebsd-packages.txt`. Это FreeBSD-сборки, а не заявление об официальной поддержке
FreeBSD со стороны upstream MongoDB. Библиотеки Helios ICU, SQLite и системные библиотеки также
используются: переносимость на другой сервер без проверки не обещается.

MongoDB поддерживает Unix-пути в `net.bindIp`; для стенда используется только такой путь.
См. [документацию MongoDB](https://www.mongodb.com/docs/manual/reference/configuration-options/#mongodb-setting-net.bindIp).
Шлюз отключает автоматическое следование redirect и передаёт статус, Location и все Set-Cookie.
См. [HTTP-контекст PHP](https://www.php.net/manual/en/context.http.php).

## Команды

Из корня репозитория, с уже настроенным SSH-ключом `~/.ssh/helios_ed25519`:

```sh
make helios-prepare   # приватный FreeBSD runtime; не требует sudo
make helios-upload    # только package.json, lockfile, src и public; npm ci --omit=dev
make helios-publish   # только публичный PHP-шлюз, не весь public_html
make helios-start
make helios-status
make helios-stop      # только проверенные процессы этого проекта; данные сохраняются
```

`helios-upload` сохраняет существующую `.env` и не переносит локальные секреты/данные/тестовую
платформу. Для обновления кода сначала остановите сервис, загрузите код и запустите снова.
`helios-start` использует FreeBSD `daemon` для Node.js; MongoDB работает отдельным процессом.
Автозапуск после перезагрузки Helios пока не установлен: повторите `make helios-start`.
Остановка не удаляет БД, попытки или runtime. Установка новых версий пакетов требует обновления
манифеста по официальному каталогу и повторных проверок, не отключения TLS-проверки.

## Подключение Gnomio — выполнено 11.10.2026

В <https://eoweblab.gnomio.com> сохранён инструмент «RAG-тренажёр · Helios · LTI 1.3».
Публичные реквизиты из Moodle находятся в
[`deploy/helios/gnomio-registration.json`](../deploy/helios/gnomio-registration.json):
Client ID — `QDIIlIIQWNH3yro`, Deployment ID — `1`.
Все шесть `MOODLE_*` внесены в приватную `.env` на Helios, исходная конфигурация сохранена
приватным backup. После перезапуска `/healthz` вернул `{"ok":true,"configured":true}`,
а `/lti/keys` — один публичный RSA-ключ. Секреты, JWT и OAuth-токены в репозиторий не переносились.

Для инструмента LTI 1.3 в Moodle укажите:

| Поле                       | Значение                                                |
| -------------------------- | ------------------------------------------------------- |
| Tool URL / Redirection URI | `https://se.ifmo.ru/~s507353/moodle-lti-rag/lti/launch` |
| Initiate login URL         | `https://se.ifmo.ru/~s507353/moodle-lti-rag/lti/login`  |
| Public keyset URL          | `https://se.ifmo.ru/~s507353/moodle-lti-rag/lti/keys`   |
| Контейнер запуска          | Новое окно                                              |

Разрешён только AGS grade sync. Передача имени и почты установлена в Never; Names and Role
Provisioning, Tool Settings и Deep Linking выключены. Технический ID и роли остаются частью
LTI-запуска. В курсе Test (ID 2) включено Show in activity chooser через More → LTI External tools;
в последний пустой раздел добавлен отдельный элемент
[«RAG-рекомендательная система: три задания (LTI)»](https://eoweblab.gnomio.com/mod/lti/view.php?id=6).
Тип оценки — Point, максимум — 10; прежние элементы SCORM не изменялись.

У вымышленного `student1` (технический ID 3) через Moodle «Войти как» выполнены 0 → 7 → 10.
После каждой доставки прочитан настоящий User report Moodle: одна и та же строка получила
0.00, 7.00 и 10.00 при диапазоне 0–10. В тренажёре итог — 10/10, история — 0 и 7.
Администратор с курсной ролью Teacher получил просмотр с отключённой отправкой.
Этот исходный проход не был отдельным обычным входом ученика и не проверял неадминистративного Instructor.
Затем пользователь самостоятельно вошёл под `student1` после завершения режима «Войти как».
Новый запуск из курса подтвердил Learner/ID 3, восстановил 10/10 и две прежние попытки 7/10 и 0/10
с подтверждённой доставкой. Обычный User report этого ученика по-прежнему показывает 10.00 из 10.
Новая попытка и отправка оценки в этом повторном проходе не выполнялись; пароль вводил только пользователь.
Затем создан и зачислен только как Student вымышленный `student2` (ID 4). Пароль создал и ввёл
пользователь. Обычный вход и новый запуск из курса показали пустую сессию и историю; пустые ответы
дали 0/10. После обновления сохранились 0/10, один запрос доставки и отсутствие истории A.
Настоящий Grader report подтвердил `student1 = 10.00 / student2 = 0.00` в одной колонке grade item ID 5,
без ручных исправлений и изменений SCORM.

[Протокол с границами проверки](gnomio-lti-evidence.json),
[журнал 10/10](screenshots/gnomio-lti-student1-grade-10.jpg),
[тренажёр и история](screenshots/gnomio-lti-student1-10.jpg),
[просмотр Teacher](screenshots/gnomio-lti-instructor.jpg).
[Обычный вход: тренажёр](screenshots/gnomio-student1-normal-login-app.jpg),
[сохранённые 10/10](screenshots/gnomio-student1-normal-login-result.jpg),
[история 7/0](screenshots/gnomio-student1-normal-login-history.jpg),
[User report](screenshots/gnomio-student1-normal-login-gradebook.jpg).
[Итоговый журнал A=10 / B=0](screenshots/gnomio-gradebook-final-10-0.jpg),
[результат B](screenshots/gnomio-student2-0-result.jpg),
[собственная история B](screenshots/gnomio-student2-history.jpg).
Общий итог курса имеет другую шкалу из-за существующих SCORM; его настройки не менялись.

При новой регистрации копируйте точные реквизиты Moodle и заполняйте все шесть `MOODLE_*`
вместе. До регистрации `/healthz` показывает `configured:false`, а login возвращает 503;
фиктивная платформа не включается. Исторический `helios-evidence.json` относится именно
к такому состоянию до подключения, а новый протокол Gnomio — к состоянию после него.

## Деплой портфолио

В соседнем репозитории `web-languages-portfolio` механизм исключений расширен до
`DEPLOY_PRESERVE_PATHS=mkdocs-deployment-lab,moodle-lti-rag`. Он применяется к загрузке,
созданию backup, активации, восстановлению и ручному rollback. Старая переменная одного пути
сохранена: при отсутствии новой переменной к её значению автоматически добавляется каталог LTI.

Эти изменения пока локальные, без коммита и пуша. Старый workflow на GitHub не получает их
автоматически: не запускайте его деплой/rollback до публикации исправлений. Независимые
каталоги исключены также из backup портфолио; для них нужен собственный backup.

## Проверки и ограничения

- `make check-ci`, `make test-docker` — штатные проверки приложения.
- LTI-тест подпапки проверяет подписанный запуск, перенаправления, assets, Origin, 0/7/10,
  изоляцию A/B и Instructor, но использует синтетическую платформу и тестовую БД.
- `node scripts/verify-helios-gateway.mjs` — отдельная проверка настоящего PHP-шлюза с локальным
  транспортным fixture. Нужен PHP CLI и свободный loopback-порт 30353. Проверяются тело POST,
  Cookie/Origin/CSRF, два Set-Cookie, 303, HEAD и ошибки 400/403/405/413/502. Это не настоящий Moodle.
- Публичные HTTP-проверки Helios и версии runtime фиксируются отдельно в `helios-evidence.json`.
- Реальные подписанные запуски Gnomio и разные оценки двух синтетических учеников 10/0
  зафиксированы в `gnomio-lti-evidence.json`, включая обычные входы, пустую начальную историю B
  и настоящий общий Grader report. Отдельный неадминистративный Instructor и
  отрицательные запросы 400/403 с действующей Gnomio-сессией этим протоколом не доказаны.
- `node scripts/verify-helios-public.mjs` повторяет публичные HTTP-проверки без учебной сессии
  и передачи оценок. Скриншот проверенной в браузере стартовой страницы:
  `screenshots/helios-https-landing.jpg`.
- Шлюз поддерживает GET/HEAD/POST, до 128 КиБ тела запроса и до 2 МиБ ответа. WebSocket и
  произвольное потоковое проксирование не поддерживаются; тренажёру они не требуются.
- `se.ifmo.ru/~user/` — общий origin. Подпапка и Path cookies не изолируют студенческие сайты
  друг от друга. Сохранены Secure/HttpOnly/SameSite и `__Host-` cookie с Path=/, но для реальных
  персональных данных нужен отдельный доверенный origin. Стенд предназначен для учебных
  синтетических участников. HSTS на общем домене контролирует внешний HTTPS-сервер, не шлюз.
- Общие Apache/nginx access logs контролируются администраторами Helios. Исключение query string
  одноразового `/session/start?ticket=...` из этих журналов не настроено и не подтверждено.
  Это ещё одно ограничение учебного стенда; не считайте его готовым для реальных учеников.
