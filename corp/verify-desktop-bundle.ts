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
 * быть не должно (S-B11, D-24). С `--update-url` дополнительно проверяется фид раздачи
 * `magnit-mac.yml` в каталоге сборки: он обязан существовать, ссылаться на лежащие рядом архивы и
 * называть их фактический sha512 (S-B16). Проверяются ВСЕ бандлы каталога — сборка тега кладёт
 * туда обе архитектуры macOS. Код выхода 1 при любом расхождении, список расхождений — в stderr.
 */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const EXPECTED_APP_ID = "ai.opencode.desktop.magnit"
export const EXPECTED_PRODUCT_NAME = "OpenCode Magnit"
export const EXPECTED_BUNDLE_NAME = `${EXPECTED_PRODUCT_NAME}.app`

/** Значения ванильной сборки: встретиться в корпоративном бандле они не должны (AC-139). */
const VANILLA_APP_ID = "ai.opencode.desktop"
const VANILLA_PRODUCT_NAME = "OpenCode"

/**
 * Все `*.app` в каталоге сборки; если передан сам бандл — список из него одного.
 *
 * Список, а не первое попадание: сборка тега кладёт в `dist` обе архитектуры macOS
 * (`mac-arm64/` и `mac/`), и проверка одного бандла молча пропускала бы вторую (S-B16).
 */
export function findAppBundles(target: string): string[] {
  if (target.endsWith(".app")) return [target]
  const found: string[] = []
  const stack = [target]
  while (stack.length) {
    const dir = stack.shift()!
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith(".app")) found.push(full)
      else stack.push(full)
    }
  }
  return found
}

/** Ищет `*.app` в каталоге сборки; если передан сам бандл — возвращает его. */
export function findAppBundle(target: string): string {
  const found = findAppBundles(target)
  if (!found.length) throw new Error(`бандл .app не найден в ${target}`)
  return found[0]!
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

/** Каталог кеша обновлений ванильной сборки: выводится из `name` пакета `@opencode-ai/desktop` (F42). */
const VANILLA_UPDATER_CACHE_DIR = "@opencode-aidesktop-updater"

/** Каталог кеша обновлений канала `magnit` (S-B13): `sanitizeFileName(name) + "-updater"`. */
const EXPECTED_UPDATER_CACHE_DIR = "opencode-magnit-desktop-updater"

/**
 * Расхождения конфигурации апдейтера: чужой фид (AC-149), адрес не из переменной сборки (AC-153)
 * и общий с ванильной сборкой каталог кеша обновлений (AC-191, S-B13).
 */
export function checkFeed(file: string, text: string, updateUrl?: string): string[] {
  const problems: string[] = []
  const feed = readFeed(text)
  // S-B13: общий каталог кеша означает, что корпоративная сборка ищет обновление там, где его
  // кладёт ванильная. Отсутствие ключа проверкой не считается — его не было и в прежних бандлах;
  // ловится ровно неправильное значение.
  if (text.includes(VANILLA_UPDATER_CACHE_DIR))
    problems.push(`${file}: каталог кеша обновлений ${VANILLA_UPDATER_CACHE_DIR} — общий с ванильной сборкой`)
  const cacheDir = feed["updaterCacheDirName"]
  if (cacheDir !== undefined && cacheDir !== EXPECTED_UPDATER_CACHE_DIR)
    problems.push(`${file}: updaterCacheDirName ${cacheDir}, ожидался ${EXPECTED_UPDATER_CACHE_DIR}`)
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

/**
 * Имя фида раздачи Desktop (S-B16).
 *
 * electron-builder формирует его из канала блока `publish` (`magnit`) и площадки: `<канал>-mac.yml`.
 * Ровно этот файл апдейтер запрашивает у `CORP_DESKTOP_UPDATE_URL` — без него бандл с включённым
 * автообновлением получает 404 и не обновляется никогда.
 */
export const UPDATE_FEED_NAME = "magnit-mac.yml"

/**
 * Пары «файл — sha512» из фида раздачи: верхнеуровневые `path`/`sha512` и по одной на элемент
 * списка `files` (там ключ называется `url`).
 *
 * Разбор построчный, как и `readFeed`: полноценный YAML-парсер ради двух ключей в сборочный
 * скрипт не тянется. Элемент `files` начинается со строки `- url: …`; относящийся к нему `sha512`
 * — ближайший следующий, до начала следующего элемента.
 */
export function parseFeedEntries(text: string): { file: string; sha512: string }[] {
  const entries: { file: string; sha512: string }[] = []
  let current: { file: string; sha512: string } | undefined
  const top: { file?: string; sha512?: string } = {}
  for (const line of text.split("\n")) {
    const item = /^\s*-\s*url:\s*(.+?)\s*$/.exec(line)
    if (item) {
      current = { file: unquote(item[1]!), sha512: "" }
      entries.push(current)
      continue
    }
    const pair = /^(\s*)([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (!pair) continue
    const [, indent, key, raw] = pair
    const value = unquote(raw!)
    if (indent!.length > 0) {
      if (current && key === "sha512") current.sha512 = value
      continue
    }
    current = undefined
    if (key === "path") top.file = value
    if (key === "sha512") top.sha512 = value
  }
  if (top.file !== undefined) entries.push({ file: top.file, sha512: top.sha512 ?? "" })
  return entries
}

function unquote(value: string) {
  return value.replace(/^['"]|['"]$/g, "")
}

/** sha512 файла в том виде, в котором его пишет electron-builder: base64. */
export function sha512(file: string) {
  return createHash("sha512").update(fs.readFileSync(file)).digest("base64")
}

/**
 * Расхождения фида раздачи в каталоге сборки (S-B16).
 *
 * Проверяется то, из-за чего обновление молча не докатывается: фида нет вовсе; он ссылается на
 * архив, которого рядом нет (апдейтер получит 404 после того, как уже сообщил о новой версии);
 * sha512 в фиде не совпадает с фактическим файлом (апдейтер скачает архив и отвергнет его на
 * проверке целостности — «обновление есть, но не ставится»).
 */
export function checkUpdateFeed(dir: string): string[] {
  const problems: string[] = []
  const feed = path.join(dir, UPDATE_FEED_NAME)
  if (!fs.existsSync(feed)) {
    problems.push(`${UPDATE_FEED_NAME} не найден в ${dir}: апдейтеру нечего запрашивать`)
    return problems
  }
  const entries = parseFeedEntries(fs.readFileSync(feed, "utf8"))
  if (!entries.length) {
    problems.push(`${UPDATE_FEED_NAME}: нет ни одной записи path/files[].url`)
    return problems
  }
  for (const entry of entries) {
    if (!entry.file) {
      problems.push(`${UPDATE_FEED_NAME}: пустая ссылка на артефакт`)
      continue
    }
    const artifact = path.join(dir, entry.file)
    if (!fs.existsSync(artifact)) {
      problems.push(`${UPDATE_FEED_NAME}: ${entry.file} — файла нет рядом с фидом`)
      continue
    }
    if (!entry.sha512) {
      problems.push(`${UPDATE_FEED_NAME}: ${entry.file} — нет sha512`)
      continue
    }
    const actual = sha512(artifact)
    if (actual !== entry.sha512) {
      problems.push(`${UPDATE_FEED_NAME}: ${entry.file} — sha512 ${entry.sha512}, фактический ${actual}`)
    }
  }
  return problems
}

/** Полная проверка бандла. Пустой список — бандл соответствует критериям AC-139, AC-149, AC-153. */
export function verifyBundle(target: string, options: { updateUrl?: string } = {}): string[] {
  const problems: string[] = []
  const bundles = findAppBundles(target)
  if (!bundles.length) throw new Error(`бандл .app не найден в ${target}`)
  // Каталог, куда electron-builder кладёт фид и архивы раздачи: сам переданный путь, если это
  // каталог сборки, и каталог рядом с бандлом, если проверяется отдельный `.app`.
  const dist = target.endsWith(".app") ? path.dirname(target) : target

  for (const app of bundles) {
    // Префикс нужен только когда бандлов несколько (обе архитектуры macOS): иначе сообщение
    // «Info.plist: …» не говорит, о какой из двух сборок речь.
    const where = bundles.length > 1 ? `${path.relative(dist, app) || path.basename(app)}: ` : ""
    if (path.basename(app) !== EXPECTED_BUNDLE_NAME) {
      problems.push(`${where}путь бандла оканчивается на ${path.basename(app)}, ожидалось ${EXPECTED_BUNDLE_NAME}`)
    }

    const plist = path.join(app, "Contents", "Info.plist")
    if (!fs.existsSync(plist)) problems.push(`${where}Info.plist не найден: ${plist}`)
    else problems.push(...checkPlist(fs.readFileSync(plist, "utf8")).map((problem) => `${where}${problem}`))

    const feed = path.join(app, "Contents", "Resources", "app-update.yml")
    const hasFeed = fs.existsSync(feed)
    if (options.updateUrl === undefined && hasFeed) {
      problems.push(`${where}app-update.yml есть в бандле, хотя CORP_DESKTOP_UPDATE_URL при сборке не задавался`)
    }
    if (options.updateUrl !== undefined && !hasFeed) {
      problems.push(`${where}app-update.yml в бандле отсутствует, хотя CORP_DESKTOP_UPDATE_URL при сборке задан`)
    }
    if (hasFeed)
      problems.push(
        ...checkFeed("app-update.yml", fs.readFileSync(feed, "utf8"), options.updateUrl).map(
          (problem) => `${where}${problem}`,
        ),
      )
  }

  // Фид раздачи проверяется ровно тогда, когда сборка шла с адресом обновлений: без адреса
  // автообновления нет вовсе и фида быть не должно (S-B11, D-24).
  if (options.updateUrl !== undefined) problems.push(...checkUpdateFeed(dist))

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
  const bundles = findAppBundles(target)
  if (bundles.length > 1) console.log(`проверяемые бандлы: ${bundles.map((app) => path.basename(path.dirname(app))).join(", ")}`)
  const problems = verifyBundle(target, { updateUrl })
  if (problems.length === 0) {
    console.log("бандл соответствует корпоративной идентичности и фиду обновлений (AC-139, AC-149, AC-153, S-B16)")
    process.exit(0)
  }
  for (const problem of problems) console.error(`расхождение: ${problem}`)
  process.exit(1)
}
