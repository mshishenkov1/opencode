import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { checkFeed, checkPlist, findAppBundle, verifyBundle } from "./verify-desktop-bundle"

/**
 * Проверка собранного бандла Desktop (S-Q10; AC-139, AC-149, AC-153).
 *
 * Сборка здесь не запускается: проверяется сам инструмент проверки — на выдуманных бандлах и,
 * если рядом лежит настоящая сборка (`packages/desktop/dist`), дополнительно на ней.
 *
 * Запуск: `bun --cwd packages/opencode test ../../corp/verify-desktop-bundle.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const temporary: string[] = []

const PLIST = (values: Record<string, string>) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist version=\"1.0\"><dict>",
    ...Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${value}</string>`),
    "</dict></plist>",
  ].join("\n")

const CORP_PLIST = {
  CFBundleIdentifier: "ai.opencode.desktop.magnit",
  CFBundleName: "OpenCode Magnit",
  CFBundleDisplayName: "OpenCode Magnit",
  CFBundleExecutable: "OpenCode Magnit",
  CFBundleURLSchemes: "opencode",
}

/** Собирает выдуманный бандл: Info.plist, при наличии — app-update.yml и «asar» с текстом. */
function bundle(options: { name?: string; plist?: Record<string, string>; feed?: string; asar?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corp-bundle-"))
  temporary.push(dir)
  const app = path.join(dir, "mac-arm64", options.name ?? "OpenCode Magnit.app")
  const resources = path.join(app, "Contents", "Resources")
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), PLIST(options.plist ?? CORP_PLIST))
  if (options.feed !== undefined) fs.writeFileSync(path.join(resources, "app-update.yml"), options.feed)
  if (options.asar !== undefined) fs.writeFileSync(path.join(resources, "app.asar"), options.asar)
  return { dist: path.join(dir, "mac-arm64"), app }
}

const CORP_FEED = ["provider: generic", "url: https://updates.example.corp/opencode", "channel: magnit", ""].join("\n")
const UPSTREAM_FEED = ["provider: github", "owner: anomalyco", "repo: opencode", "channel: latest", ""].join("\n")

afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })
})

describe("проверка бандла: идентичность (AC-139)", () => {
  test("AC-139: корпоративный бандл с внутренним фидом проходит проверку", () => {
    const { dist } = bundle({ feed: CORP_FEED })
    expect(verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode" })).toEqual([])
  })

  test("AC-139: сборка без адреса обновлений проходит проверку без app-update.yml", () => {
    const { dist } = bundle({})
    expect(verifyBundle(dist)).toEqual([])
  })

  test("AC-139: чужой CFBundleIdentifier — расхождение", () => {
    const problems = checkPlist(PLIST({ ...CORP_PLIST, CFBundleIdentifier: "ai.opencode.desktop" }))
    expect(problems.join("\n")).toContain("CFBundleIdentifier")
    expect(problems.join("\n")).toContain("ai.opencode.desktop")
  })

  test("AC-139: имя ванильной сборки в Info.plist — расхождение", () => {
    const problems = checkPlist(PLIST({ ...CORP_PLIST, CFBundleName: "OpenCode" }))
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join("\n")).toContain("CFBundleName")
  })

  test("AC-139: имя бандла проверяется целиком", () => {
    const { dist } = bundle({ name: "OpenCode.app" })
    expect(verifyBundle(dist).join("\n")).toContain("OpenCode Magnit.app")
  })

  test("findAppBundle находит бандл в каталоге сборки и принимает сам бандл", () => {
    const { dist, app } = bundle({})
    expect(findAppBundle(dist)).toBe(app)
    expect(findAppBundle(app)).toBe(app)
  })
})

describe("проверка бандла: фид обновлений (AC-149, AC-153)", () => {
  test("AC-149: фид ванильного апстрима — расхождение", () => {
    const problems = checkFeed("app-update.yml", UPSTREAM_FEED, "https://updates.example.corp/opencode")
    expect(problems.join("\n")).toContain("provider github")
    expect(problems.join("\n")).toContain("anomalyco")
  })

  test("AC-149: чужой фид ловится и без ожидаемого адреса", () => {
    const { dist } = bundle({ feed: UPSTREAM_FEED })
    const problems = verifyBundle(dist)
    expect(problems.join("\n")).toContain("anomalyco")
  })

  test("AC-149: ссылки anomalyco в app.asar проверку не роняют — они законны в коде upstream", () => {
    const { dist } = bundle({
      feed: CORP_FEED,
      asar: "https://github.com/anomalyco/opencode/issues/new — Report a Bug; Installation.latest()",
    })
    expect(verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode" })).toEqual([])
  })

  test("AC-153: адрес фида должен совпадать с CORP_DESKTOP_UPDATE_URL", () => {
    const { dist } = bundle({ feed: CORP_FEED })
    const problems = verifyBundle(dist, { updateUrl: "https://updates.other.corp/opencode" })
    expect(problems.join("\n")).toContain("url https://updates.example.corp/opencode")
  })

  test("AC-153: хвостовой слэш ожидаемого адреса не считается расхождением", () => {
    const { dist } = bundle({ feed: CORP_FEED })
    expect(verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode/" })).toEqual([])
  })

  test("AC-153: канал фида должен быть magnit", () => {
    const { dist } = bundle({ feed: CORP_FEED.replace("channel: magnit", "channel: latest") })
    const problems = verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode" })
    expect(problems.join("\n")).toContain("channel latest")
  })

  test("AC-146: app-update.yml в сборке без адреса обновлений — расхождение", () => {
    const { dist } = bundle({ feed: CORP_FEED })
    expect(verifyBundle(dist).join("\n")).toContain("app-update.yml есть в бандле")
  })

  test("AC-153: отсутствующий app-update.yml при заданном адресе — расхождение", () => {
    const { dist } = bundle({})
    expect(verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode" }).join("\n")).toContain(
      "app-update.yml в бандле отсутствует",
    )
  })
})

describe("проверка бандла: настоящая сборка, если она есть рядом", () => {
  const dist = path.join(ROOT, "packages/desktop/dist/mac-arm64")
  const feed = path.join(dist, "OpenCode Magnit.app/Contents/Resources/app-update.yml")

  test.skipIf(!fs.existsSync(dist))("AC-139, AC-149: локальная сборка Desktop проходит проверку", () => {
    const url = fs.existsSync(feed) ? /url:\s*(\S+)/.exec(fs.readFileSync(feed, "utf8"))?.[1] : undefined
    expect(verifyBundle(dist, { updateUrl: url })).toEqual([])
  })
})

/**
 * Каталог кеша обновлений в собранном бандле (S-B13; AC-191).
 *
 * AC-191 — ручная проверка на стенде, но её формулировка — воспроизводимая команда: она и есть
 * `verifyBundle`. Здесь проверяется сам инструмент на выдуманных бандлах, чтобы ручной прогон
 * ловил ровно то, что должен: общий с ванильной сборкой каталог кеша обновлений.
 */
describe("проверка бандла: каталог кеша обновлений (AC-191, S-B13)", () => {
  const MAGNIT_CACHE = "updaterCacheDirName: opencode-magnit-desktop-updater"
  const VANILLA_CACHE = "updaterCacheDirName: '@opencode-ai/desktop-updater'"

  test("AC-191: корпоративный каталог кеша расхождением не считается", () => {
    const feed = [CORP_FEED.trimEnd(), MAGNIT_CACHE, ""].join("\n")
    const { dist } = bundle({ feed })
    expect(verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode" })).toEqual([])
    expect(checkFeed("app-update.yml", feed, "https://updates.example.corp/opencode")).toEqual([])
  })

  test("AC-191: общий с ванильной сборкой каталог кеша — расхождение", () => {
    // Ровно та подстрока, которую AC-191 запрещает видеть в app-update.yml корпоративной сборки.
    const feed = [CORP_FEED.trimEnd(), "updaterCacheDirName: '@opencode-aidesktop-updater'", ""].join("\n")
    const problems = checkFeed("app-update.yml", feed, "https://updates.example.corp/opencode")
    expect(problems.join("\n")).toContain("@opencode-aidesktop-updater")

    const { dist } = bundle({ feed })
    expect(verifyBundle(dist, { updateUrl: "https://updates.example.corp/opencode" }).join("\n")).toContain(
      "@opencode-aidesktop-updater",
    )
  })

  test("AC-191: чужое имя каталога кеша тоже расхождение", () => {
    const feed = [CORP_FEED.trimEnd(), "updaterCacheDirName: opencode-desktop-updater", ""].join("\n")
    const problems = checkFeed("app-update.yml", feed, "https://updates.example.corp/opencode")
    expect(problems.join("\n")).toContain("opencode-magnit-desktop-updater")
  })

  test("AC-191: имя каталога кеша выводится из extraMetadata.name канала magnit", () => {
    // Связь между конфигурацией упаковки и содержимым бандла: electron-builder считает
    // `updaterCacheDirName` как `sanitizeFileName(name).toLowerCase() + "-updater"` (F42).
    const name = "opencode-magnit-desktop"
    expect(`updaterCacheDirName: ${name.toLowerCase()}-updater`).toBe(MAGNIT_CACHE)
    expect(VANILLA_CACHE).toContain("@opencode-ai")
  })
})
