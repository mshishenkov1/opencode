#!/usr/bin/env bun
/**
 * Сборка корпоративных артефактов (S-B1…S-B4).
 *
 *   bun run corp/build.ts [--targets darwin-arm64,linux-x64] [--desktop] [--skip-cli] [--publish]
 *                         [--skip-install] [--skip-embed-web-ui] [--win]
 *
 * Версия артефактов — `<версия upstream>-magnit.<N>`, где `N` берётся из env `CORP_BUILD`
 * или файла `corp/version` (по умолчанию `1`). Исходные `package.json` upstream не правятся:
 * версия передаётся через `OPENCODE_VERSION`, который `@opencode-ai/script` принимает как есть.
 *
 * Корпоративные build-константы (S-C2) подставляет `packages/opencode/script/build.ts` из
 * env `CORP_HUB_URL` и файла `corp/config/opencode.corp.json`. Без `CORP_HUB_URL` собирается
 * ванильная сборка — с предупреждением, но без ошибки (S-C6).
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
const hubUrl = process.env["CORP_HUB_URL"]?.trim()
const channel = process.env["OPENCODE_CHANNEL"]?.trim() || "magnit"

console.log(`версия сборки: ${version}`)
if (!hubUrl) console.warn("CORP_HUB_URL не задан — собирается ванильная сборка (S-C6)")
else console.log(`адрес Hub: ${hubUrl}`)

const env = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: channel,
  ...(hubUrl ? { CORP_HUB_URL: hubUrl } : {}),
}

const artifacts: { name: string; file: string }[] = []

if (!flag("skip-cli")) {
  const targets = parseTargets()
  console.log(`сборка CLI: ${targets.join(", ")}`)
  // script/build.ts собирает все цели за один прогон. Если запрошена ровно текущая платформа,
  // используем его флаг --single; иначе собираем полный список и упаковываем нужные каталоги.
  const current = `${process.platform}-${process.arch}` as CliTarget
  const single = targets.length === 1 && targets[0] === current
  const scriptArgs = [
    ...(single ? ["--single"] : []),
    // Прокидываем служебные флаги upstream-скрипта: пропуск установки платформенных пакетов
    // и пропуск встраивания веб-UI (нужны для быстрых локальных прогонов и офлайн-сборок).
    ...(flag("skip-install") ? ["--skip-install"] : []),
    ...(flag("skip-embed-web-ui") ? ["--skip-embed-web-ui"] : []),
  ]
  await $`bun run ./script/build.ts ${scriptArgs}`.cwd(path.join(ROOT, "packages/opencode")).env(env)

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
  if (process.platform === "darwin") {
    console.log("сборка Desktop mac-arm64")
    await $`bun run package:mac`.cwd(desktop).env(env)
  }
  if (process.platform === "win32") {
    console.log("сборка Desktop win-x64")
    await $`bun run package:win`.cwd(desktop).env(env)
  }
  const release = path.join(desktop, "release")
  if (fs.existsSync(release)) {
    for (const entry of fs.readdirSync(release)) {
      if (!/\.(dmg|zip|exe|msi|blockmap)$/.test(entry)) continue
      artifacts.push({ name: entry, file: path.join(release, entry) })
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
