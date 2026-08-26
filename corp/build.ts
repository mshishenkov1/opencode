#!/usr/bin/env bun
/**
 * Сборка корпоративных артефактов (S-B1…S-B4, S-B16).
 *
 *   bun run corp/build.ts [--targets darwin-arm64,linux-x64] [--desktop] [--skip-cli] [--publish]
 *                         [--skip-install] [--skip-embed-web-ui] [--win] [--channel latest]
 *                         [--arm64] [--x64] [--from-dist [каталог]]
 *                         [--publish-to github|internal] [--print-version]
 *
 * `--print-version` печатает версию корп-сборки и выходит — её читает автотег `corp-release.yml`.
 * `--from-dist` ничего не собирает, а берёт готовые артефакты (по умолчанию — из каталогов
 * локальной сборки, с аргументом — из указанного каталога рекурсивно): так задание публикации в CI
 * выкладывает то, что собрали предыдущие задания (S-B16). `--arm64`/`--x64` задают архитектуры
 * Desktop для macOS; без них собирается архитектура раннера.
 *
 * Версия артефактов — `<версия upstream>-magnit.<N>`, где `N` берётся из env `CORP_BUILD`
 * или файла `corp/version` (по умолчанию `1`). Исходные `package.json` upstream не правятся:
 * версия передаётся через `OPENCODE_VERSION`, который `@opencode-ai/script` принимает как есть,
 * а в Desktop — через `extraMetadata.version` electron-builder.
 *
 * Канал сборки (`--channel`, по умолчанию `latest`) уходит в `OPENCODE_CHANNEL` и задаёт имя и
 * идентификатор Desktop-приложения, набор иконок и режим веб-UI. `latest` — канал раздачи; в
 * терминах Desktop ему соответствует корпоративный канал `magnit`: приложение называется
 * «OpenCode Magnit» и имеет собственный `appId` (S-B3, S-B10). Адрес сервера обновлений Desktop —
 * `CORP_DESKTOP_UPDATE_URL`; без него автообновление выключено (S-B11).
 *
 * Корпоративные build-константы (S-C2) подставляют `packages/opencode/script/build.ts` (CLI) и
 * `packages/opencode/script/build-node.ts` (сервер, встроенный в Desktop) из env `CORP_HUB_URL`
 * и файла `corp/config/opencode.corp.json`; веб-UI получает адрес Hub через
 * `VITE_OPENCODE_CORP_HUB_URL`. Без `CORP_HUB_URL` собирается ванильная сборка — с
 * предупреждением, но без ошибки (S-C6).
 */

import { $ } from "bun"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "packages/opencode/dist")

const CLI_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"] as const
type CliTarget = (typeof CLI_TARGETS)[number]

function flag(name: string) {
  return process.argv.includes(`--${name}`)
}

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function upstreamVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/opencode/package.json"), "utf8"))
  if (typeof pkg.version !== "string") throw new Error("packages/opencode/package.json: нет поля version")
  return pkg.version as string
}

function corpBuildNumber() {
  const fromEnv = process.env["CORP_BUILD"]?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(ROOT, "corp/version")
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, "utf8").trim()
    if (value) return value
  }
  return "1"
}

/** Версия корп-сборки (S-B1). */
export function corpVersion(upstream = upstreamVersion(), build = corpBuildNumber()) {
  return `${upstream}-magnit.${build}`
}

function parseTargets(): CliTarget[] {
  const raw = option("targets")
  if (!raw) return [...CLI_TARGETS]
  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const unknown = requested.filter((value) => !CLI_TARGETS.includes(value as CliTarget))
  if (unknown.length) throw new Error(`неизвестные цели: ${unknown.join(", ")}; доступны: ${CLI_TARGETS.join(", ")}`)
  return requested as CliTarget[]
}

function sha256(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/** Имя каталога сборки, как его формирует `packages/opencode/script/build.ts`. */
export function distName(target: CliTarget) {
  const [os, arch] = target.split("-")
  return `opencode-${os === "win32" ? "windows" : os}-${arch}`
}

const version = corpVersion()

/**
 * `--print-version` — версия корп-сборки одной строкой, без сборки и без побочных действий (S-B16).
 *
 * Читатель — автотег `.github/workflows/corp-release.yml`: он подставляет напечатанное значение в
 * `v<версия>`. Печать идёт ДО разбора канала и адресов, чтобы вычисление тега не зависело от
 * настроек раздачи: тег обязан считаться и в чистом клоне без единой переменной окружения.
 */
if (flag("print-version")) {
  console.log(version)
  process.exit(0)
}

// Адрес Hub нормализуется здесь же, как в script/build.ts: хвостовой `/` ломает сравнение адресов.
const hubUrl = process.env["CORP_HUB_URL"]?.trim().replace(/\/+$/, "")
/**
 * Канал сборки (S-B3).
 *
 * `latest` — канал раздачи: так его называет CLI upstream (`@opencode-ai/script`), и с ним
 * `opencode` не считается preview-сборкой. Значение переопределяется `--channel` или env
 * `OPENCODE_CHANNEL`; `dev` оставляет прежнее «OpenCode Dev» для отладки.
 */
const channel = option("channel")?.trim() || process.env["OPENCODE_CHANNEL"]?.trim() || "latest"

/** Допустимые каналы сборки (S-B3, S-B10). */
const CHANNELS = ["latest", "magnit", "dev", "beta", "prod"] as const

// Неизвестный канал — громкая ошибка, а не молчаливый откат в `dev` (S-B10, D-25, AC-144):
// именно молчаливый откат дал «OpenCode Dev» в корпоративной раздаче (BUG-I4-003).
if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) {
  console.error(`неизвестный канал сборки: ${channel}; допустимые: ${CHANNELS.join(", ")}`)
  process.exit(1)
}

/**
 * Куда публикуются артефакты (S-B4, S-B16).
 *
 * `github` — прежнее поведение: черновик GitHub Release (остаётся резервом и способом отдать
 * сборку руками). `internal` — выкладка на внутренний HTTPS-хост, с которого читают апдейтер
 * Desktop (`CORP_DESKTOP_UPDATE_URL`) и `opencode upgrade` (`CORP_CLI_UPDATE_URL`).
 *
 * Значение проверяется здесь, до сборки: опечатка в режиме публикации обязана стоить секунду, а
 * не час сборки Desktop. Молчаливый откат в `github` запрещён по тем же причинам, что и молчаливый
 * откат канала (BUG-I4-003): «опубликовал не туда» неотличимо от «не опубликовал».
 */
const PUBLISH_MODES = ["github", "internal"] as const
type PublishMode = (typeof PUBLISH_MODES)[number]
const publishTo = (option("publish-to")?.trim() || "github") as PublishMode
if (!PUBLISH_MODES.includes(publishTo)) {
  console.error(`неизвестный режим публикации: ${publishTo}; допустимые: ${PUBLISH_MODES.join(", ")}`)
  process.exit(1)
}

/**
 * Тот же канал в терминах Desktop (S-B3, ревизия 1.6).
 *
 * Канал корпоративной раздачи Desktop — `magnit`: собственный `appId`
 * `ai.opencode.desktop.magnit`, имя «OpenCode Magnit» и собственный каталог пользовательских данных
 * (S-B10). Прежний перевод `latest → prod` отдавал корпоративной сборке идентичность ванильного
 * апстрима: общий каталог данных и апдейтер, тянущий релизы `anomalyco/opencode` (ревизия 1.6).
 */
const desktopChannel = channel === "latest" || channel === "magnit" ? "magnit" : channel

/**
 * Адрес внутреннего сервера обновлений Desktop (S-B11, D-24).
 *
 * Нормализуется как адрес Hub — хвостовой `/` ломает сравнение адресов. Умолчания нет: без
 * переменной блок `publish` в ветке `magnit` не появляется, `app-update.yml` в бандл не попадает и
 * автообновление выключено целиком — «нет адреса» означает «нет автообновления», а не «спросить у
 * апстрима».
 */
const desktopUpdateUrl = process.env["CORP_DESKTOP_UPDATE_URL"]?.trim().replace(/\/+$/, "")

/**
 * Адрес внутреннего источника обновлений CLI (S-B14, D-34). Без него явный `opencode upgrade` в
 * корпоративной сборке не делает ни одного сетевого запроса и говорит, что обновление выполняется
 * централизованно: молчаливый уход на релизы `anomalyco/opencode` — тот же путь, которым ванильный
 * артефакт попадал в корпоративную сборку.
 */
const cliUpdateUrl = process.env["CORP_CLI_UPDATE_URL"]?.trim().replace(/\/+$/, "")

/**
 * Адрес статического каталога коннекторов (S-C10 п.1, D-40). Задан — витрина работает и без Hub:
 * каталог раздаётся файлом с того же внутреннего хоста, что фид обновлений, и не требует ни ключа,
 * ни сессии. Не задан — каталог берётся из Hub, как до ревизии 1.11.
 */
const catalogUrl = process.env["CORP_CATALOG_URL"]?.trim().replace(/\/+$/, "")

console.log(`версия сборки: ${version}`)
console.log(`канал сборки: ${channel}${desktopChannel === channel ? "" : ` (Desktop: ${desktopChannel})`}`)
// S-C10 п.2: ванильной сборка становится только при отсутствии **обоих** корпоративных адресов —
// сборка без Hub, но с каталогом остаётся корпоративной (D-40).
if (!hubUrl && !catalogUrl) console.warn("CORP_HUB_URL и CORP_CATALOG_URL не заданы — собирается ванильная сборка (S-C6)")
else if (!hubUrl) console.warn("CORP_HUB_URL не задан — сборка без Hub: витрина работает на статическом каталоге (S-C10)")
else console.log(`адрес Hub: ${hubUrl}`)
if (hubUrl && !cliUpdateUrl)
  console.warn("CORP_CLI_UPDATE_URL не задан — явный `opencode upgrade` будет отказывать (S-B14)")
else if (cliUpdateUrl) console.log(`источник обновлений CLI: ${cliUpdateUrl}`)
if (catalogUrl) console.log(`статический каталог: ${catalogUrl}`)

const env = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: channel,
  // CORP_HUB_URL читают бандлеры бинарника и встроенного сервера, VITE_… — сборка веб-UI:
  // vite не видит `define` бандлера и берёт только переменные с префиксом VITE_ (S-C2, S-I2).
  ...(hubUrl ? { CORP_HUB_URL: hubUrl, VITE_OPENCODE_CORP_HUB_URL: hubUrl } : {}),
  // CORP_CLI_UPDATE_URL читают бандлеры бинарника и встроенного сервера (S-B14).
  ...(cliUpdateUrl ? { CORP_CLI_UPDATE_URL: cliUpdateUrl } : {}),
  // CORP_CATALOG_URL — адрес статического каталога (S-C10 п.1): его читают те же два бандлера,
  // а VITE_… — сборка веб-UI, где по нему считается включённость корп-функций (S-C10 п.2).
  ...(catalogUrl ? { CORP_CATALOG_URL: catalogUrl, VITE_OPENCODE_CORP_CATALOG_URL: catalogUrl } : {}),
}

/**
 * Собранные артефакты (S-B4, S-B16).
 *
 * `kind` нужен публикации на внутренний сервер: у CLI и Desktop разные адреса раздачи и разная
 * раскладка. `target` у CLI — цель сборки в терминах `process.platform`/`process.arch`: имя файла
 * на сервере обязано совпадать с тем, которое запрашивает `corp/upgrade.ts` (S-B14).
 */
type Artifact = { name: string; file: string; kind: "cli" | "desktop"; target?: CliTarget }
const artifacts: Artifact[] = []

/**
 * `--from-dist [каталог]` — взять готовые артефакты, ничего не собирая (S-B16).
 *
 * Задание публикации в CI не собирает заново: артефакты приходят из заданий `build-cli` и
 * `build-desktop` скачанными в один каталог и выкладываются одним проходом. Иначе фид пришлось бы
 * выкладывать из задания, которое не видит артефактов CLI, и порядок «сначала артефакты, потом
 * фид» соблюсти было бы нечем.
 *
 * Без аргумента берутся каталоги локальной сборки. Каталог, указанный явно, обходится рекурсивно:
 * `actions/download-artifact` раскладывает каждый артефакт в свой подкаталог.
 */
const fromDist = flag("from-dist")
const fromDistDir = (() => {
  const value = option("from-dist")
  return value && !value.startsWith("--") ? path.resolve(value) : undefined
})()

/** Файлы каталога рекурсивно; внутрь бандлов `.app` не заходим — там десятки тысяч файлов. */
function walk(root: string): string[] {
  const files: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.shift()!
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(".app")) stack.push(full)
        continue
      }
      files.push(full)
    }
  }
  return files
}

if (fromDist) {
  // Имена архивов CLI фиксированы версией сборки: так классификация не зависит от того, в каком
  // каталоге лежит файл, и архив Desktop с расширением .zip не будет принят за архив CLI.
  const cliNames = new Map<string, CliTarget>(
    CLI_TARGETS.map((target) => [`${distName(target)}-${version}.zip`, target] as const),
  )
  const roots = fromDistDir
    ? [fromDistDir]
    : [DIST, path.join(ROOT, "packages/desktop/dist"), path.join(ROOT, "packages/desktop/release")]
  console.log(`артефакты берутся готовыми (--from-dist): ${roots.join(", ")}`)
  const seen = new Set<string>()
  for (const root of roots) {
    for (const file of walk(root)) {
      const name = path.basename(file)
      if (seen.has(name)) continue
      const target = cliNames.get(name)
      if (target) {
        seen.add(name)
        artifacts.push({ name, file, kind: "cli", target })
        continue
      }
      if (!/\.(dmg|zip|exe|msi|blockmap|yml)$/.test(name)) continue
      // `builder-debug.yml` — отладочный дамп конфигурации electron-builder, а не фид раздачи.
      if (name === "builder-debug.yml") continue
      seen.add(name)
      artifacts.push({ name, file, kind: "desktop" })
    }
  }
}

if (!fromDist && !flag("skip-cli")) {
  const targets = parseTargets()
  console.log(`сборка CLI: ${targets.join(", ")}`)
  // script/build.ts по умолчанию собирает все свои цели; список нужных передаётся ему через
  // CORP_TARGETS (S-B2), иначе сборка одной цели в CI занимает время всех четырёх.
  const scriptArgs = [
    // Прокидываем служебные флаги upstream-скрипта: пропуск установки платформенных пакетов
    // и пропуск встраивания веб-UI (нужны для быстрых локальных прогонов и офлайн-сборок).
    ...(flag("skip-install") ? ["--skip-install"] : []),
    ...(flag("skip-embed-web-ui") ? ["--skip-embed-web-ui"] : []),
  ]
  await $`bun run ./script/build.ts ${scriptArgs}`
    .cwd(path.join(ROOT, "packages/opencode"))
    .env({ ...env, CORP_TARGETS: targets.join(",") })

  for (const target of targets) {
    const name = distName(target)
    const dir = path.join(DIST, name)
    const binary = path.join(dir, "bin", target.startsWith("win32") ? "opencode.exe" : "opencode")
    if (!fs.existsSync(binary)) {
      console.warn(`пропуск ${name}: бинарник не найден (${binary})`)
      continue
    }
    const zip = path.join(DIST, `${name}-${version}.zip`)
    const zipped = await $`zip -qr ${zip} ${name}`
      .cwd(DIST)
      .nothrow()
      .then((result) => result.exitCode === 0)
    // Без zip (например, на голом Windows-стенде) отдаём сам бинарник — молчаливого пропуска нет.
    if (!zipped) console.warn(`не удалось упаковать ${name}: zip недоступен, публикуется бинарник`)
    artifacts.push(
      zipped
        ? { name: path.basename(zip), file: zip, kind: "cli", target }
        : { name: `${name}/bin`, file: binary, kind: "cli", target },
    )
  }
}

const desktopDir = path.join(ROOT, "packages/desktop")

/** Файлы раздачи Desktop в каталоге сборки: архивы, установщики, blockmap и фид апдейтера. */
function collectDesktopArtifacts() {
  // `directories.output` в electron-builder.config.ts — `dist`; `release` остаётся в списке для
  // сборок, где каталог вывода переопределён.
  for (const dir of [path.join(desktopDir, "dist"), path.join(desktopDir, "release")]) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      // `yml` — фид апдейтера (`magnit-mac.yml`), который electron-builder кладёт рядом с
      // архивами (S-B11, S-B16). Без него в списке артефактов апдейтеру не по чему сравнивать
      // версии: бандл собирался с адресом фида, а сам фид оставался на раннере и пропадал вместе
      // с ним — обновление не докатывалось ни разу.
      if (!/\.(dmg|zip|exe|msi|blockmap|yml)$/.test(entry)) continue
      // `builder-debug.yml` — отладочный дамп конфигурации electron-builder, а не фид раздачи.
      // На сервере обновлений ему делать нечего, а в архиве артефактов он путает: `*.yml` в
      // раздаче означает «фид», и второй yml рядом читается как второй фид.
      if (entry === "builder-debug.yml") continue
      artifacts.push({ name: entry, file: path.join(dir, entry), kind: "desktop" })
    }
  }
}

if (!fromDist && flag("desktop")) {
  const desktop = desktopDir
  const wantWindows = flag("win")
  if (wantWindows && process.platform !== "win32") {
    // S-B3: молчаливый пропуск запрещён — Windows-сборка делается на Windows-стенде или в CI.
    console.error("сборка Desktop для win-x64 требует Windows: запустите её на Windows-стенде или в CI")
    process.exit(1)
  }
  // CORP_DESKTOP_UPDATE_URL читают `electron-builder.config.ts` (блок `publish` канала `magnit`) и
  // `electron.vite.config.ts` (build-константа `OPENCODE_CORP_UPDATE_URL` главного процесса) — S-B11.
  const desktopEnv = {
    ...env,
    OPENCODE_CHANNEL: desktopChannel,
    ...(desktopUpdateUrl ? { CORP_DESKTOP_UPDATE_URL: desktopUpdateUrl } : {}),
  }
  if (desktopUpdateUrl) console.log(`адрес обновлений Desktop: ${desktopUpdateUrl}`)
  else console.warn("CORP_DESKTOP_UPDATE_URL не задан — автообновление Desktop выключено (S-B11)")
  /**
   * Аргументы electron-builder (S-B1, S-B4).
   *
   * `extraMetadata.version` — версия S-B1: сам `packages/desktop/package.json` не правится, а
   * upstream-скрипт `scripts/prepare.ts`, который это делает, в цепочке S-B3 не участвует.
   * `--publish never` — публикация только по `--publish` этого скрипта (S-B4). Источник обновлений
   * задаёт не он, а блок `publish` канала `magnit`: без `CORP_DESKTOP_UPDATE_URL` блока нет, и
   * `app-update.yml` в бандл не попадает вовсе (S-B11).
   */
  const packageArgs = ["--publish", "never", `-c.extraMetadata.version=${version}`]

  // electron-builder только упаковывает уже собранный каталог `out/`. Без этих двух шагов он падает
  // на «Application entry file out/main/index.js was not found» (BUG-I4-003):
  //   prebuild — иконки и metainfo канала + сборка встроенного сервера (script/build-node.ts,
  //              туда же уходят CORP_HUB_URL и OPENCODE_VERSION);
  //   build    — electron-vite: main, preload и веб-UI (VITE_OPENCODE_CORP_HUB_URL).
  console.log("Desktop: prebuild (иконки, metainfo, встроенный сервер)")
  await $`bun run prebuild`.cwd(desktop).env(desktopEnv)
  console.log("Desktop: electron-vite build")
  await $`bun run build`.cwd(desktop).env(desktopEnv)

  const entry = path.join(desktop, "out/main/index.js")
  // Молчаливый пропуск запрещён (S-B3): без entry electron-builder соберёт битый архив.
  if (!fs.existsSync(entry)) {
    console.error(`сборка Electron не создала ${entry}`)
    process.exit(1)
  }

  if (process.platform === "darwin") {
    /**
     * Архитектуры Desktop для macOS (S-B16).
     *
     * Обе архитектуры собираются ОДНИМ вызовом electron-builder: он пишет один фид `magnit-mac.yml`
     * со списком `files` для arm64 и x64, и апдейтер выбирает в нём свою запись. Два раздельных
     * вызова (или два задания CI) дали бы два фида, из которых на сервере остался бы последний, —
     * половина парка перестала бы видеть обновления. arm64-раннер собирает x64 сам, кросс-стенда
     * не нужно.
     */
    const arches = [...(flag("arm64") ? ["--arm64"] : []), ...(flag("x64") ? ["--x64"] : [])]
    console.log(
      `сборка Desktop mac${arches.length ? ` (${arches.join(" ")})` : ` (архитектура раннера: ${process.arch})`}`,
    )
    await $`bun run package:mac ${arches} ${packageArgs}`.cwd(desktop).env(desktopEnv)
  }
  if (process.platform === "win32") {
    console.log("сборка Desktop win-x64")
    await $`bun run package:win ${packageArgs}`.cwd(desktop).env(desktopEnv)
  }
  collectDesktopArtifacts()
}

if (artifacts.length === 0) {
  console.warn("артефактов нет")
} else {
  console.log("\nартефакты и sha256:")
  for (const artifact of artifacts) console.log(`  ${sha256(artifact.file)}  ${artifact.name}`)
}

/**
 * Публикация на внутренний HTTPS-хост (S-B16, D-24, D-34).
 *
 * Адрес записи — `CORP_ARTIFACTS_ENDPOINT`, учётные данные — из окружения CI
 * (`CORP_ARTIFACTS_TOKEN` либо пара `CORP_ARTIFACTS_USER`/`CORP_ARTIFACTS_PASSWORD`). Путь объекта
 * берётся из адресов ЧТЕНИЯ (`CORP_DESKTOP_UPDATE_URL`, `CORP_CLI_UPDATE_URL`): раздача и запись
 * идут на один хост (портал AI Lab), поэтому второй раскладки заводить нельзя — она разъехалась бы
 * с тем, что запрашивают клиенты.
 *
 * Раскладка:
 *   <CORP_DESKTOP_UPDATE_URL>/magnit-mac.yml  + архивы, dmg и blockmap плоско рядом;
 *   <CORP_CLI_UPDATE_URL>/latest              — JSON `{version}` (S-B14);
 *   <CORP_CLI_UPDATE_URL>/<версия>/opencode-<os>-<arch>.zip — ровно то имя, которое строит
 *   `artifactUrl()` в `corp/upgrade.ts`; расхождение имени означает 404 у каждого `opencode upgrade`.
 *
 * ПОРЯДОК: сначала все артефакты, потом фиды. Клиент, опросивший фид в момент выкладки, обязан
 * получить либо старую версию целиком, либо новую целиком; фид, опубликованный раньше архивов, даёт
 * 404 на скачивании — «обновление есть, но не ставится».
 */
async function publishInternal() {
  const endpoint = process.env["CORP_ARTIFACTS_ENDPOINT"]?.trim().replace(/\/+$/, "")
  if (!endpoint) {
    console.error("публикация internal требует CORP_ARTIFACTS_ENDPOINT — адреса записи внутреннего хоста")
    process.exit(1)
  }
  const token = process.env["CORP_ARTIFACTS_TOKEN"]?.trim()
  const user = process.env["CORP_ARTIFACTS_USER"]?.trim()
  const password = process.env["CORP_ARTIFACTS_PASSWORD"]
  const method = process.env["CORP_ARTIFACTS_METHOD"]?.trim().toUpperCase() === "POST" ? "POST" : "PUT"
  const auth = token
    ? `Bearer ${token}`
    : user
      ? `Basic ${Buffer.from(`${user}:${password ?? ""}`).toString("base64")}`
      : undefined
  if (!auth) console.warn("учётные данные записи не заданы — запрос уходит без заголовка Authorization")

  /** Путь раздачи из адреса чтения: `https://host/opencode/desktop` → `/opencode/desktop`. */
  function base(url: string, what: string) {
    try {
      return `${endpoint}${new URL(url).pathname.replace(/\/+$/, "")}`
    } catch {
      console.error(`${what}: неразбираемый адрес ${url}`)
      process.exit(1)
    }
  }

  const contentType = (name: string) =>
    name.endsWith(".yml")
      ? "text/yaml"
      : name.endsWith(".json") || !name.includes(".")
        ? "application/json"
        : "application/octet-stream"

  async function upload(url: string, body: Blob | string, name: string) {
    console.log(`  ${method} ${url}`)
    const response = await fetch(url, {
      method,
      body,
      headers: { "content-type": contentType(name), ...(auth ? { authorization: auth } : {}) },
    }).catch((error) => {
      console.error(`не удалось выложить ${name}: ${error}`)
      process.exit(1)
    })
    if (!response.ok) {
      console.error(`не удалось выложить ${name}: ${response.status} ${response.statusText}`)
      process.exit(1)
    }
  }

  const cli = artifacts.filter((artifact) => artifact.kind === "cli")
  const desktop = artifacts.filter((artifact) => artifact.kind === "desktop")
  const desktopFeeds = desktop.filter((artifact) => artifact.name.endsWith(".yml"))
  const desktopPayload = desktop.filter((artifact) => !artifact.name.endsWith(".yml"))

  if (cli.length && !cliUpdateUrl) {
    console.error("публикация CLI требует CORP_CLI_UPDATE_URL: без него неизвестно, куда класть архивы (S-B14)")
    process.exit(1)
  }
  if (desktop.length && !desktopUpdateUrl) {
    console.error("публикация Desktop требует CORP_DESKTOP_UPDATE_URL: без него неизвестно, куда класть фид (S-B11)")
    process.exit(1)
  }
  const cliBase = cliUpdateUrl ? base(cliUpdateUrl, "публикация CLI") : ""
  const desktopBase = desktopUpdateUrl ? base(desktopUpdateUrl, "публикация Desktop") : ""

  console.log(`\nпубликация на внутренний сервер: ${endpoint}`)
  console.log("шаг 1 — артефакты")
  for (const artifact of cli) {
    // Имя на сервере — то, которое запрашивает `corp/upgrade.ts`: `opencode-<platform>-<arch>.zip`
    // (без версии в имени, версия — в каталоге). Цель сборки уже записана как `<platform>-<arch>`.
    const name = `opencode-${artifact.target}.zip`
    await upload(`${cliBase}/${encodeURIComponent(version)}/${name}`, Bun.file(artifact.file), name)
  }
  for (const artifact of desktopPayload) {
    await upload(`${desktopBase}/${artifact.name}`, Bun.file(artifact.file), artifact.name)
  }

  console.log("шаг 2 — фиды (после артефактов: иначе клиент увидит версию, которой ещё нет)")
  for (const artifact of desktopFeeds) {
    await upload(`${desktopBase}/${artifact.name}`, Bun.file(artifact.file), artifact.name)
  }
  if (cli.length) {
    await upload(`${cliBase}/latest`, JSON.stringify({ version }), "latest")
  }
  console.log(`опубликовано: ${artifacts.length} объект(ов), версия ${version}`)
}

if (flag("publish")) {
  // S-B4: публикация только по явному флагу.
  if (publishTo === "internal") {
    await publishInternal()
  } else {
    const tag = `v${version}`
    console.log(`\nпубликация релиза ${tag}`)
    const notes = [
      `Корпоративная сборка OpenCode ${version}.`,
      "",
      "| Артефакт | sha256 |",
      "|---|---|",
      ...artifacts.map((artifact) => `| ${artifact.name} | \`${sha256(artifact.file)}\` |`),
    ].join("\n")
    await $`gh release create ${tag} --draft --title ${tag} --notes ${notes} ${artifacts.map((a) => a.file)}`.cwd(ROOT)
  }
} else if (artifacts.length) {
  console.log("\nпубликация пропущена: добавьте --publish")
}
