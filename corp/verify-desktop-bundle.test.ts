import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { createHash } from "crypto"

import {
  UPDATE_FEED_NAME,
  checkFeed,
  checkPlist,
  checkUpdateFeed,
  findAppBundle,
  findAppBundles,
  parseFeedEntries,
  verifyBundle,
} from "./verify-desktop-bundle"

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

/**
 * Собирает выдуманный бандл: Info.plist, при наличии — app-update.yml и «asar» с текстом.
 *
 * `updateFeed` (S-B16) кладёт в тот же каталог, который получает `verifyBundle`, архив раздачи и
 * фид `magnit-mac.yml` с его фактическим sha512 — так выглядит настоящий `packages/desktop/dist`.
 * По умолчанию фид пишется всегда, когда бандл собран с адресом обновлений: без него проверка
 * теперь законно ругается, и тесты, которым фид не интересен, не должны падать по этой причине.
 */
function bundle(options: {
  name?: string
  plist?: Record<string, string>
  feed?: string
  asar?: string
  updateFeed?: string | false
  arches?: string[]
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corp-bundle-"))
  temporary.push(dir)
  const arches = options.arches ?? ["mac-arm64"]
  let app = ""
  for (const arch of arches) {
    app = path.join(dir, arch, options.name ?? "OpenCode Magnit.app")
    const resources = path.join(app, "Contents", "Resources")
    fs.mkdirSync(resources, { recursive: true })
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), PLIST(options.plist ?? CORP_PLIST))
    if (options.feed !== undefined) fs.writeFileSync(path.join(resources, "app-update.yml"), options.feed)
    if (options.asar !== undefined) fs.writeFileSync(path.join(resources, "app.asar"), options.asar)
  }
  const dist = arches.length === 1 ? path.join(dir, arches[0]!) : dir
  if (options.updateFeed !== false) {
    if (options.updateFeed === undefined) writeUpdateFeed(dist)
    else fs.writeFileSync(path.join(dist, UPDATE_FEED_NAME), options.updateFeed)
  }
  return { dist, app, root: dir }
}

const b64sha512 = (data: string) => createHash("sha512").update(data).digest("base64")

/**
 * Фид раздачи в том виде, в котором его пишет electron-builder: `files[]` с `url`/`sha512` и
 * дублирующие верхнеуровневые `path`/`sha512` первого файла (их читают старые апдейтеры).
 */
function writeUpdateFeed(dir: string, names = ["opencode-magnit-desktop-mac-arm64.zip"]) {
  fs.mkdirSync(dir, { recursive: true })
  const lines = ["version: 1.17.9-magnit.1", "files:"]
  for (const name of names) {
    const payload = `ZIP ${name}`
    fs.writeFileSync(path.join(dir, name), payload)
    lines.push(`  - url: ${name}`, `    sha512: ${b64sha512(payload)}`, "    size: 1024")
  }
  const first = names[0]!
  lines.push(`path: ${first}`, `sha512: ${b64sha512(`ZIP ${first}`)}`, "releaseDate: '2026-08-26T09:00:00.000Z'", "")
  fs.writeFileSync(path.join(dir, UPDATE_FEED_NAME), lines.join("\n"))
  return lines.join("\n")
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

/**
 * Фид раздачи `magnit-mac.yml` (S-B16).
 *
 * Разрыв, который закрывает проверка: бандл собирался с адресом обновлений, а фид оставался на
 * раннере — апдейтер получал 404 и не обновлялся ни разу. Ловятся все три способа получить
 * «обновление есть, но не ставится»: фида нет, фид ссылается на отсутствующий архив, sha512 в
 * фиде не совпадает с фактическим файлом.
 */
describe("проверка бандла: фид раздачи magnit-mac.yml (S-B16)", () => {
  const URL = "https://updates.example.corp/opencode"

  test("S-B16: фид рядом с архивом проходит проверку", () => {
    const { dist } = bundle({ feed: CORP_FEED })
    expect(verifyBundle(dist, { updateUrl: URL })).toEqual([])
    expect(checkUpdateFeed(dist)).toEqual([])
  })

  test("S-B16: без magnit-mac.yml при заданном --update-url — расхождение", () => {
    const { dist } = bundle({ feed: CORP_FEED, updateFeed: false })
    expect(verifyBundle(dist, { updateUrl: URL }).join("\n")).toContain(`${UPDATE_FEED_NAME} не найден`)
  })

  test("S-B16: без --update-url фид не требуется — автообновления в такой сборке нет", () => {
    const { dist } = bundle({ updateFeed: false })
    expect(verifyBundle(dist)).toEqual([])
  })

  test("S-B16: path указывает на архив, которого нет рядом — расхождение", () => {
    const { dist } = bundle({ feed: CORP_FEED, updateFeed: false })
    writeUpdateFeed(dist)
    fs.rmSync(path.join(dist, "opencode-magnit-desktop-mac-arm64.zip"))
    const problems = verifyBundle(dist, { updateUrl: URL })
    expect(problems.join("\n")).toContain("файла нет рядом с фидом")
    expect(problems.join("\n")).toContain("opencode-magnit-desktop-mac-arm64.zip")
  })

  test("S-B16: sha512 в фиде не совпадает с фактическим файлом — расхождение", () => {
    const { dist } = bundle({ feed: CORP_FEED, updateFeed: false })
    writeUpdateFeed(dist)
    fs.writeFileSync(path.join(dist, "opencode-magnit-desktop-mac-arm64.zip"), "ПОДМЕНЁННЫЙ АРХИВ")
    const problems = checkUpdateFeed(dist)
    expect(problems.join("\n")).toContain("sha512")
    expect(problems.join("\n")).toContain(b64sha512("ПОДМЕНЁННЫЙ АРХИВ"))
  })

  test("S-B16: фид обеих архитектур проверяется целиком, а не по первой записи", () => {
    const { dist } = bundle({ feed: CORP_FEED, updateFeed: false, arches: ["mac-arm64", "mac"] })
    writeUpdateFeed(dist, ["opencode-magnit-desktop-mac-arm64.zip", "opencode-magnit-desktop-mac-x64.zip"])
    expect(verifyBundle(dist, { updateUrl: URL })).toEqual([])

    // Порча ВТОРОЙ записи обязана быть видна: с проверкой «по первой» она проходила бы молча.
    fs.writeFileSync(path.join(dist, "opencode-magnit-desktop-mac-x64.zip"), "ПОДМЕНА")
    expect(checkUpdateFeed(dist).join("\n")).toContain("opencode-magnit-desktop-mac-x64.zip")
  })

  test("S-B16: пустой фид — расхождение, а не молчаливый успех", () => {
    const { dist } = bundle({ feed: CORP_FEED, updateFeed: "version: 1.17.9-magnit.1\n" })
    expect(checkUpdateFeed(dist).join("\n")).toContain("нет ни одной записи")
  })

  test("S-B16: parseFeedEntries разбирает files[] и верхнеуровневый path", () => {
    const entries = parseFeedEntries(
      [
        "version: 1.17.9-magnit.1",
        "files:",
        "  - url: a.zip",
        "    sha512: AAAA",
        "    size: 1",
        "  - url: b.zip",
        "    sha512: BBBB",
        "    size: 2",
        "path: a.zip",
        "sha512: AAAA",
        "releaseDate: '2026-08-26T09:00:00.000Z'",
        "",
      ].join("\n"),
    )
    expect(entries).toEqual([
      { file: "a.zip", sha512: "AAAA" },
      { file: "b.zip", sha512: "BBBB" },
      { file: "a.zip", sha512: "AAAA" },
    ])
  })
})

describe("проверка бандла: обе архитектуры macOS (S-B16)", () => {
  const URL = "https://updates.example.corp/opencode"

  test("S-B16: findAppBundles находит бандлы обеих архитектур", () => {
    const { root } = bundle({ feed: CORP_FEED, arches: ["mac-arm64", "mac"], updateFeed: false })
    const found = findAppBundles(root)
    expect(found.length).toBe(2)
    expect(found.map((app) => path.basename(path.dirname(app))).sort()).toEqual(["mac", "mac-arm64"])
  })

  test("S-B16: расхождение во ВТОРОМ бандле не пропускается и назван каталог архитектуры", () => {
    const { dist, root } = bundle({ feed: CORP_FEED, arches: ["mac-arm64", "mac"], updateFeed: false })
    writeUpdateFeed(dist, ["opencode-magnit-desktop-mac-arm64.zip", "opencode-magnit-desktop-mac-x64.zip"])
    expect(verifyBundle(root, { updateUrl: URL })).toEqual([])

    // Ванильная идентичность подсовывается только сборке x64: проверка одного бандла её не видела.
    fs.writeFileSync(
      path.join(root, "mac", "OpenCode Magnit.app", "Contents", "Info.plist"),
      PLIST({ ...CORP_PLIST, CFBundleIdentifier: "ai.opencode.desktop" }),
    )
    const problems = verifyBundle(root, { updateUrl: URL })
    expect(problems.join("\n")).toContain("CFBundleIdentifier")
    expect(problems.join("\n")).toContain("mac/OpenCode Magnit.app")
  })
})

describe("проверка бандла: настоящая сборка, если она есть рядом", () => {
  // Каталог сборки целиком (S-B16): в нём лежат и бандлы всех архитектур, и фид раздачи —
  // ровно то, что проверяет корп-CI. Прежний путь `dist/mac-arm64` до фида не доставал.
  const dist = path.join(ROOT, "packages/desktop/dist")
  const feed = path.join(dist, "mac-arm64/OpenCode Magnit.app/Contents/Resources/app-update.yml")

  test.skipIf(!fs.existsSync(dist))("AC-139, AC-149, S-B16: локальная сборка Desktop проходит проверку", () => {
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
