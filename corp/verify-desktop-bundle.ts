#!/usr/bin/env bun
/**
 * Проверка собранного бандла Desktop канала `magnit` (S-B9, S-B10, S-B11, S-Q10; AC-139, AC-149, AC-153).
 *
 * Уровень «собранный бандл» из S-Q10: значения `Info.plist`, наличие и содержимое `app-update.yml`
 * и отсутствие чужого фида обновлений. Проверяются только конфигурации апдейтера, а не любое
 * вхождение строки `anomalyco` в бандл: в `Resources/app.asar` она остаётся законно — в пункте
 * «Report a Bug» и в `Installation.latest()` upstream-кода.
 *
 * Запуск:
 *   bun run corp/verify-desktop-bundle.ts <путь к .app или к каталогу dist> [--update-url <адрес>]
 *
 * Без `--update-url` ожидается сборка с выключенным автообновлением: `app-update.yml` в бандле
 * быть не должно (S-B11, D-24). Код выхода 1 при любом расхождении, список расхождений — в stderr.
 */
import fs from "node:fs"
import path from "node:path"

export const EXPECTED_APP_ID = "ai.opencode.desktop.magnit"
export const EXPECTED_PRODUCT_NAME = "OpenCode Magnit"
export const EXPECTED_BUNDLE_NAME = `${EXPECTED_PRODUCT_NAME}.app`

/** Значения ванильной сборки: встретиться в корпоративном бандле они не должны (AC-139). */
const VANILLA_APP_ID = "ai.opencode.desktop"
const VANILLA_PRODUCT_NAME = "OpenCode"

/** Ищет `*.app` в каталоге сборки; если передан сам бандл — возвращает его. */
export function findAppBundle(target: string): string {
  if (target.endsWith(".app")) return target
  const stack = [target]
  while (stack.length) {
    const dir = stack.shift()!
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith(".app")) return full
      stack.push(full)
    }
  }
  throw new Error(`бандл .app не найден в ${target}`)
}

/** Пары `<key>…</key><string>…</string>` из Info.plist. */
export function readPlist(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  const pattern = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g
  for (const match of text.matchAll(pattern)) values[match[1]!] = match[2]!
  return values
}

/** Простые пары `ключ: значение` из конфигурации апдейтера (`app-update.yml`). */
export function readFeed(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "")
  }
  return values
}

/** Расхождения `Info.plist` с корпоративной идентичностью (AC-139). */
export function checkPlist(text: string): string[] {
  const problems: string[] = []
  const values = readPlist(text)
  const expected: Record<string, string> = {
    CFBundleIdentifier: EXPECTED_APP_ID,
    CFBundleName: EXPECTED_PRODUCT_NAME,
    CFBundleDisplayName: EXPECTED_PRODUCT_NAME,
    CFBundleExecutable: EXPECTED_PRODUCT_NAME,
  }
  for (const [key, want] of Object.entries(expected)) {
    if (values[key] === undefined) problems.push(`Info.plist: ключ ${key} отсутствует`)
    else if (values[key] !== want) problems.push(`Info.plist: ${key} = ${values[key]}, ожидалось ${want}`)
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === VANILLA_APP_ID) problems.push(`Info.plist: ${key} содержит идентификатор ванильной сборки ${value}`)
    if (value === VANILLA_PRODUCT_NAME) problems.push(`Info.plist: ${key} содержит имя ванильной сборки «${value}»`)
  }
  return problems
}

/** Расхождения конфигурации апдейтера: чужой фид (AC-149) и адрес не из переменной сборки (AC-153). */
export function checkFeed(file: string, text: string, updateUrl?: string): string[] {
  const problems: string[] = []
  const feed = readFeed(text)
  if (feed["provider"] === "github") problems.push(`${file}: provider github — фид ванильного апстрима`)
  if (feed["owner"] !== undefined) problems.push(`${file}: owner ${feed["owner"]} — фид ванильного апстрима`)
  if (/github\.com\/anomalyco|anomalyco/.test(text)) problems.push(`${file}: ссылка на anomalyco в конфигурации обновлений`)
  if (updateUrl === undefined) return problems
  const expected = updateUrl.trim().replace(/\/+$/, "")
  if (feed["provider"] !== "generic") problems.push(`${file}: provider ${feed["provider"]}, ожидался generic`)
  if ((feed["url"] ?? "").replace(/\/+$/, "") !== expected) {
    problems.push(`${file}: url ${feed["url"]}, ожидался ${expected}`)
  }
  if (feed["channel"] !== "magnit") problems.push(`${file}: channel ${feed["channel"]}, ожидался magnit`)
  return problems
}

/** Полная проверка бандла. Пустой список — бандл соответствует критериям AC-139, AC-149, AC-153. */
export function verifyBundle(target: string, options: { updateUrl?: string } = {}): string[] {
  const problems: string[] = []
  const app = findAppBundle(target)

  if (path.basename(app) !== EXPECTED_BUNDLE_NAME) {
    problems.push(`путь бандла оканчивается на ${path.basename(app)}, ожидалось ${EXPECTED_BUNDLE_NAME}`)
  }

  const plist = path.join(app, "Contents", "Info.plist")
  if (!fs.existsSync(plist)) problems.push(`Info.plist не найден: ${plist}`)
  else problems.push(...checkPlist(fs.readFileSync(plist, "utf8")))

  const feed = path.join(app, "Contents", "Resources", "app-update.yml")
  const hasFeed = fs.existsSync(feed)
  if (options.updateUrl === undefined && hasFeed) {
    problems.push("app-update.yml есть в бандле, хотя CORP_DESKTOP_UPDATE_URL при сборке не задавался")
  }
  if (options.updateUrl !== undefined && !hasFeed) {
    problems.push("app-update.yml в бандле отсутствует, хотя CORP_DESKTOP_UPDATE_URL при сборке задан")
  }
  if (hasFeed) problems.push(...checkFeed("app-update.yml", fs.readFileSync(feed, "utf8"), options.updateUrl))

  return problems
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const index = args.indexOf("--update-url")
  const updateUrl = index === -1 ? undefined : args[index + 1]
  const target = args.find((value, position) => !value.startsWith("--") && position !== index + 1)
  if (!target) {
    console.error("укажите путь к бандлу .app или к каталогу сборки Desktop")
    process.exit(1)
  }

  console.log(`проверка бандла: ${target}`)
  console.log(updateUrl ? `ожидаемый адрес обновлений: ${updateUrl}` : "ожидание: автообновление выключено (без app-update.yml)")
  const problems = verifyBundle(target, { updateUrl })
  if (problems.length === 0) {
    console.log("бандл соответствует корпоративной идентичности и фиду обновлений (AC-139, AC-149, AC-153)")
    process.exit(0)
  }
  for (const problem of problems) console.error(`расхождение: ${problem}`)
  process.exit(1)
}
