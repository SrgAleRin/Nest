# Выпуск Nest для Windows

Практический runbook: собрать NSIS, проверить установку, выложить generic-feed и включить автообновление.

## 1. Требования

- Windows 10/11 x64;
- Node.js 24 и pnpm 12.18 (`corepack enable` или установленный pnpm);
- git в `PATH`;
- Visual Studio **не** нужен: `node-pty` ставится из prebuilds, в конфиге `npmRebuild: false`.

## 2. Сборка

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm dist
```

`pnpm dist` делает `electron-vite build`, затем `electron-builder` (NSIS x64) и генерирует `latest.yml`. Результат в `apps/desktop/release`:

```text
Nest-Setup-<version>.exe
Nest-Setup-<version>.exe.blockmap
latest.yml
win-unpacked/
```

Версия берётся из `apps/desktop/package.json`. Перед релизом поднимите её (например, `0.1.1`) и закоммитьте.

Если `electron-builder` падает с `EBUSY` на `release\win-unpacked.tmp`, каталог держит другой процесс (антивирус, индексатор, файловый watcher, открытый терминал). Закройте его или перезапустите приложение-держатель; обойти старый лок можно сборкой в свежий output: `electron-builder --config.directories.output=%TEMP%\nest-dist-<timestamp>`, а затем `node scripts/make-latest-yml.mjs` для этого каталога.

## 3. CI-релиз (GitHub Actions)

В репозитории два workflow:

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — на каждый push в `main` и на pull request: install, typecheck, lint, unit/integration, build и e2e. При падении e2e `test-results` с трейсами уходят артефактом;
- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — по тегу `v*`: проверка версии, typecheck, lint, unit/integration, `pnpm dist`, проверка артефактов, packaged-смоук и черновик GitHub Release с `Nest-Setup-<version>.exe`, `.blockmap` и `latest.yml`. Полный e2e остаётся блокирующим в `ci` на `main`; релиз не дублирует его, чтобы не удлинять сборку и не зависеть от таймингов UI-тестов.

### Что нужно один раз

- репозиторий на GitHub и remote `origin`; Actions включены (по умолчанию);
- workflow слушает ветку `main`;
- по желанию: branch protection на `main` с обязательным job `windows` из `ci` и tag protection для `v*`, чтобы релизный тег мог поставить только владелец;
- **публичный репозиторий**, если feed должен жить на GitHub Releases: ассеты приватного релиза отдаются только с токеном, которого у установленного Nest нет. Для приватного репозитория соберите артефакты в CI и выложите три файла на свой HTTPS-хостинг.

### Выпуск версии

1. Поднимите `version` в `apps/desktop/package.json` (для порядка и в корневом `package.json`), закоммитьте и запушьте `main`. Дождитесь зелёного `ci`.
2. Поставьте тег ровно на эту версию и запушьте его:

   ```powershell
   git tag v0.1.1
   git push origin v0.1.1
   ```

   `release.yml` упадёт, если тег не совпадает с версией: это защита от публикации `latest.yml` с чужим номером.

3. Дождитесь job `release`. Установщик, `.blockmap` и `latest.yml` появятся в артефактах и в **черновике** Release.
4. Откройте черновик, проверьте ассеты и нажмите **Publish release**. Пока релиз черновик, `releases/latest/download` указывает на предыдущую версию — обновление не уйдёт раньше времени.
5. Feed URL уже встроен в приложение: `https://github.com/SrgAleRin/Nest/releases/latest/download/`. В **Settings → Updates** можно указать другой адрес; `NEST_UPDATE_URL` перекрывает и его. Для приватного хостинга используйте свой HTTPS-каталог с теми же тремя файлами.

Ручной запуск `release.yml` (`workflow_dispatch`) собирает и проверяет установщик, но не создаёт релиз — удобно для репетиции на ветке.

## 4. Проверка установщика

Тихая установка в отдельный каталог (per-user, без admin):

```powershell
$installer = "$PWD\apps\desktop\release\Nest-Setup-0.1.1.exe"
$dir = "$env:TEMP\nest-install-check"
Start-Process $installer -ArgumentList '/S', "/D=$dir" -Wait
```

Запустите смоук против установленной копии:

```powershell
$env:NEST_E2E_EXE = "$dir\Nest.exe"
pnpm --filter @nest/desktop exec playwright test e2e/packaged.spec.ts
```

Удаление:

```powershell
Start-Process "$dir\Uninstall Nest.exe" -ArgumentList '/S' -Wait
```

Установщик создаёт ярлыки в Start Menu и на рабочем столе, `Uninstall Nest.exe` и запись в «Приложения». Пользовательские данные (`%APPDATA%\Nest`) при удалении сохраняются.

На этой машине проверено: тихая установка, запуск установленной копии (PTY и БД), ярлыки в Start Menu и на рабочем столе, удаление каталога установки и ярлыков, а также `e2e/updates.spec.ts` против локального feed. Чистая Windows без Node.js пока не прогонялась.

## 5. Обновления

### Feed

Приложение использует generic-feed `electron-updater`: статический каталог с `latest.yml` и установщиком. Минимальный layout:

```text
https://updates.example.com/nest/
  latest.yml
  Nest-Setup-0.1.0.exe
  Nest-Setup-0.1.0.exe.blockmap
```

`latest.yml` уже создан `pnpm dist`; он содержит версию, имя установщика, sha512 и размер. `.blockmap` нужен для дифференциальной загрузки. Старые установщики можно хранить для откатов, но `latest.yml` всегда указывает на актуальный.

Встроенный feed — `https://github.com/SrgAleRin/Nest/releases/latest/download/`. Он используется, пока в **Settings → Updates → Update feed** не указан другой адрес. `NEST_UPDATE_URL` перекрывает и настройку, и встроенный адрес — удобно для локальной проверки. После сохранения URL проверка запускается сразу; дальше — через 20 секунд после старта и раз в 6 часов.

Публичный feed должен быть **HTTPS**: обновление выполняет код, поэтому HTTP разрешён только для `localhost`/`127.0.0.1` при локальной проверке.

### Локальная проверка обновления

1. Соберите версию `0.1.1`, установите её.
2. Поднимите статический сервер над каталогом с `latest.yml`, например `npx serve apps/desktop/release` (или любой HTTP-сервер).
3. Запустите установленный Nest с `NEST_UPDATE_URL=http://127.0.0.1:3000/`.
4. Откройте Settings → Updates → **Check now**. Для той же версии статус будет `Nest is up to date.`
5. Для реального обновления соберите `0.1.1`, положите её файлы в каталог feed и проверьте: `Version 0.1.1 found` → загрузка → **Install and restart**.

`e2e/updates.spec.ts` автоматически проверяет этот путь на упакованном приложении и локальном feed:

```powershell
$env:NEST_E2E_EXE = "$env:TEMP\nest-install-check\Nest.exe"
$env:NEST_UPDATE_FEED_DIR = "$PWD\apps\desktop\release"
pnpm --filter @nest/desktop exec playwright test e2e/updates.spec.ts
```

Без `release/win-unpacked` спецификация пропускается.

### Ограничения

- установка обновления завершает PTY-сессии: `quitAndInstall` перезапускает Nest;
- автообновление не работает в dev-сборке (`app.isPackaged === false`); `NEST_DISABLE_UPDATES=1` отключает его принудительно.

## 6. Чистая Windows

Чек-лист для машины без Node.js и dev-инструментов:

- [ ] установить `Nest-Setup-<version>.exe` (не тихо, проверить мастер и каталог);
- [ ] запустить: окно открывается, ошибок `node-pty`/`node:sqlite` нет;
- [ ] добавить git-репозиторий, открыть main checkout, запустить harness;
- [ ] закрыть окно — Nest остаётся в трее, сессия жива; Quit завершает её;
- [ ] перезапустить Nest — проект и сессия на месте;
- [ ] установить предыдущую версию, выложить новую в feed, проверить обновление и `Install and restart`;
- [ ] удалить приложение, убедиться, что ярлыки и каталог установки удалены;
- [ ] проверить `%APPDATA%\Nest\nest.db` после удаления (данные должны сохраниться).

Пункт остаётся открытым в roadmap, пока чек-лист не пройден на отдельной машине.
