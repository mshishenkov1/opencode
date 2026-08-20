#!/usr/bin/env bun
/**
 * Сборка корпоративных артефактов (S-B1…S-B4).
 *
 *   bun run corp/build.ts [--targets darwin-arm64,linux-x64] [--desktop] [--skip-cli] [--publish]
 *                         [--skip-install] [--skip-embed-web-ui] [--win] [--channel latest]
 *
 * Версия артефактов — `<версия upstream>-magnit.<N>`, где `N` берётся из env `CORP_BUILD`
 * или файла `corp/version` (по умолчанию `1`). Исходные `package.json` upstream не правятся:
 * версия передаётся через `OPENCODE_VERSION`, который `@opencode-ai/script` принимает как есть,
 * а в Desktop — через `extraMetadata.version` electron-builder.
 *
 * Канал сборки (`--channel`, по умолчанию `latest`) уходит в `OPENCODE_CHANNEL` и задаёт имя и
 * идентификатор Desktop-приложения, набор иконок и режим веб-UI. `latest` — канал раздачи:
 * приложение называется «OpenCode», а не «OpenCode Dev» (S-B3).
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

/**
 * Тот же канал в терминах Desktop (S-B3).
 *
 * `electron-builder.config.ts` и `scripts/utils.ts` знают только `dev` / `beta` / `prod` и на любом
 * другом значении молча сваливаются в `dev` — отсюда «OpenCode Dev» в раздаче (BUG-I4-003).
 * Канал раздачи у Desktop называется `prod`, поэтому `latest` переводится здесь; конфиг
 * electron-builder при этом не меняется (S-B9, AC-112).
 */
const desktopChannel = channel === "latest" ? "prod" : channel

console.log(`версия сборки: ${version}`)
console.log(`канал сборки: ${channel}${desktopChannel === channel ? "" : ` (Desktop: ${desktopChannel})`}`)
if (!hubUrl) console.warn("CORP_HUB_URL не задан — собирается ванильная сборка (S-C6)")
else console.log(`адрес Hub: ${hubUrl}`)

const env = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: channel,
  // CORP_HUB_URL читают бандлеры бинарника и встроенного сервера, VITE_… — сборка веб-UI:
  // vite не видит `define` бандлера и берёт только переменные с префиксом VITE_ (S-C2, S-I2).
  ...(hubUrl ? { CORP_HUB_URL: hubUrl, VITE_OPENCODE_CORP_HUB_URL: hubUrl } : {}),
}

const artifacts: { name: string; file: string }[] = []

if (!flag("skip-cli")) {
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
    artifacts.push(zipped ? { name: path.basename(zip), file: zip } : { name: `${name}/bin`, file: binary })
  }
}

if (flag("desktop")) {
  const desktop = path.join(ROOT, "packages/desktop")
  const wantWindows = flag("win")
  if (wantWindows && process.platform !== "win32") {
    // S-B3: молчаливый пропуск запрещён — Windows-сборка делается на Windows-стенде или в CI.
    console.error("сборка Desktop для win-x64 требует Windows: запустите её на Windows-стенде или в CI")
    process.exit(1)
  }
  const desktopEnv = { ...env, OPENCODE_CHANNEL: desktopChannel }
  /**
   * Аргументы electron-builder (S-B1, S-B4).
   *
   * `extraMetadata.version` — версия S-B1: сам `packages/desktop/package.json` не правится, а
   * upstream-скрипт `scripts/prepare.ts`, который это делает, в цепочке S-B3 не участвует.
   * `--publish never` — публикация только по `--publish` этого скрипта (S-B4); заодно в
   * приложение не кладётся `app-update.yml`, то есть корп-сборка не станет обновляться из
   * публичных релизов upstream.
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
    console.log("сборка Desktop mac-arm64")
    await $`bun run package:mac ${packageArgs}`.cwd(desktop).env(desktopEnv)
  }
  if (process.platform === "win32") {
    console.log("сборка Desktop win-x64")
    await $`bun run package:win ${packageArgs}`.cwd(desktop).env(desktopEnv)
  }
  // `directories.output` в electron-builder.config.ts — `dist`; `release` остаётся в списке для
  // сборок, где каталог вывода переопределён.
  for (const dir of [path.join(desktop, "dist"), path.join(desktop, "release")]) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.(dmg|zip|exe|msi|blockmap)$/.test(entry)) continue
      artifacts.push({ name: entry, file: path.join(dir, entry) })
    }
  }
}

if (artifacts.length === 0) {
  console.warn("артефактов нет")
} else {
  console.log("\nартефакты и sha256:")
  for (const artifact of artifacts) console.log(`  ${sha256(artifact.file)}  ${artifact.name}`)
}

if (flag("publish")) {
  // S-B4: публикация только по явному флагу.
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
} else if (artifacts.length) {
  console.log("\nпубликация пропущена: добавьте --publish")
}
