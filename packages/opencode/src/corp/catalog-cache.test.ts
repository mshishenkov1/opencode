import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as CatalogCache from "./catalog-cache"
import * as CorpSchema from "./schema"
import { liveCatalogBody, liveTagCard } from "../../test/fixture/corp-hub-live"

/**
 * Кэш каталога (S-V3, S-Q5; AC-42…AC-47, AC-117).
 *
 * Каталог данных подменяется временным, часы передаются явным аргументом — без обращений к сети
 * и к настоящему `Global.Path.data`.
 */

const dirs: string[] = []

async function dataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corp-catalog-cache-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

const HUB = "https://hub.test"
const OTHER_HUB = "https://hub2.test"

const server = (alias: string): CorpSchema.CatalogServer => ({
  alias,
  title: `Title ${alias}`,
  status: "ga",
  mode: "facade",
  mcp_url: `${HUB}/mcp/${alias}`,
})

const HOUR = 60 * 60 * 1000

describe("corp/catalog-cache (AC-42…AC-47, AC-117)", () => {
  test("AC-42: запись кладёт файл catalog-<hash>.json с правами 0o600 и полным содержимым", async () => {
    const dir = await dataDir()
    const fetchedAt = 1_700_000_000_000
    await CatalogCache.write({ hubUrl: HUB, fetchedAt, version: "2026-08-19.1", servers: [server("gitlab")] }, dir)

    const digest = createHash("sha256").update(HUB).digest("hex").slice(0, 16)
    const file = path.join(dir, "corp", `catalog-${digest}.json`)
    expect(CatalogCache.fileFor(HUB, dir)).toBe(file)

    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o600)

    const raw = JSON.parse(await fs.readFile(file, "utf8"))
    expect(raw).toEqual({
      hub_url: HUB,
      fetched_at: fetchedAt,
      version: "2026-08-19.1",
      servers: [server("gitlab")],
    })
  })

  test("AC-42: чтение возвращает записанную запись", async () => {
    const dir = await dataDir()
    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 10, version: "v1", servers: [server("tag")] }, dir)
    const entry = await CatalogCache.read(HUB, dir)
    expect(entry).toEqual({ hubUrl: HUB, fetchedAt: 10, version: "v1", servers: [server("tag")] })
  })

  test("AC-43: кэш возрастом 1 ч не считается протухшим", async () => {
    const now = 1_700_000_000_000
    const entry = { hubUrl: HUB, fetchedAt: now - HOUR, version: "v1", servers: [] }
    expect(CatalogCache.isStale(entry, now)).toBe(false)
  })

  test("AC-44: кэш возрастом 25 ч протух, TTL — 24 ч", async () => {
    expect(CatalogCache.TTL_MS).toBe(24 * HOUR)
    const now = 1_700_000_000_000
    expect(CatalogCache.isStale({ hubUrl: HUB, fetchedAt: now - 25 * HOUR, version: "v1", servers: [] }, now)).toBe(
      true,
    )
    // Ровно на границе TTL кэш ещё свежий: протухание — строго больше 24 ч.
    expect(CatalogCache.isStale({ hubUrl: HUB, fetchedAt: now - 24 * HOUR, version: "v1", servers: [] }, now)).toBe(
      false,
    )
  })

  test("AC-45: кэша нет — чтение возвращает undefined без ошибки", async () => {
    const dir = await dataDir()
    expect(await CatalogCache.read(HUB, dir)).toBeUndefined()
  })

  test("AC-46: повреждённый файл трактуется как отсутствие кэша", async () => {
    const dir = await dataDir()
    const file = CatalogCache.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{ это не JSON")
    expect(await CatalogCache.read(HUB, dir)).toBeUndefined()
  })

  test("AC-46: файл с валидным JSON, но чужой структурой — тоже отсутствие кэша", async () => {
    const dir = await dataDir()
    const file = CatalogCache.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ hub_url: HUB, fetched_at: "вчера", servers: [] }))
    expect(await CatalogCache.read(HUB, dir)).toBeUndefined()
  })

  test("AC-47: кэши разных адресов Hub лежат в разных файлах и не смешиваются", async () => {
    const dir = await dataDir()
    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 1, version: "one", servers: [server("gitlab")] }, dir)
    await CatalogCache.write({ hubUrl: OTHER_HUB, fetchedAt: 2, version: "two", servers: [server("tag")] }, dir)

    expect(CatalogCache.fileFor(HUB, dir)).not.toBe(CatalogCache.fileFor(OTHER_HUB, dir))
    const first = await CatalogCache.read(HUB, dir)
    const second = await CatalogCache.read(OTHER_HUB, dir)
    expect(first?.version).toBe("one")
    expect(first?.servers.map((s) => s.alias)).toEqual(["gitlab"])
    expect(second?.version).toBe("two")
    expect(second?.servers.map((s) => s.alias)).toEqual(["tag"])
  })

  test("AC-47: файл, записанный для другого Hub, для этого Hub не читается", async () => {
    const dir = await dataDir()
    const file = CatalogCache.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ hub_url: OTHER_HUB, fetched_at: 1, version: "v1", servers: [] }))
    expect(await CatalogCache.read(HUB, dir)).toBeUndefined()
  })

  test("AC-117: невозможность записи не выбрасывает ошибку наружу", async () => {
    const dir = await dataDir()
    // Файл на месте каталога `corp` делает mkdir невозможным.
    await fs.writeFile(path.join(dir, "corp"), "занято")
    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 1, version: "v1", servers: [] }, dir)
    expect(await CatalogCache.read(HUB, dir)).toBeUndefined()
  })
})

/**
 * Кэш и терпимый разбор каталога (S-V3, S-V14; AC-40, AC-158, AC-168).
 *
 * Кэш пишется тем же путём, что и корп-роут витрины: ответ Hub разбирается `parseCatalog`, и на диск
 * уходит ровно то, что разбор принял. Тело каталога — живое (`test/fixture/corp-hub-live.ts`).
 */
describe("corp/catalog-cache — принятые карточки и дословная модель прав (AC-40, AC-158, AC-168)", () => {
  const gitlab = {
    alias: "gitlab",
    title: "GitLab",
    owner: "Платформа",
    status: "ga",
    mode: "facade",
    mcp_url: "https://hub.test/mcp/gitlab",
    permission_model: { kind: "header_groups", groups: [{ id: "read", title: "Чтение", preset: "readonly" }] },
  }

  test("AC-158, AC-40: в кэш попадают только принятые карточки, отброшенная не сохраняется", async () => {
    const dir = await dataDir()
    const parsed = CorpSchema.parseCatalog({
      version: 1,
      servers: [gitlab, { title: "Без alias", mode: "facade", mcp_url: "https://hub.test/mcp/x" }, liveTagCard()],
    })
    if (!parsed) throw new Error("конверт должен быть разобран")
    expect(parsed.dropped).toEqual([{ reason: "alias" }])

    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 42, version: parsed.version, servers: parsed.servers }, dir)
    const entry = await CatalogCache.read(HUB, dir)

    expect(entry?.servers.map((server) => server.alias)).toEqual(["gitlab", "tag"])
    // Отброшенная карточка не «оживает» из кэша ни при чтении, ни в самом файле.
    const raw = JSON.parse(await fs.readFile(CatalogCache.fileFor(HUB, dir), "utf8"))
    expect(raw.servers).toHaveLength(2)
    expect(JSON.stringify(raw)).not.toContain("Без alias")
  })

  test("AC-168: версия каталога числом сохраняется в кэше строкой", async () => {
    const dir = await dataDir()
    const parsed = CorpSchema.parseCatalog(liveCatalogBody())
    if (!parsed) throw new Error("конверт должен быть разобран")

    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 42, version: parsed.version, servers: parsed.servers }, dir)
    const raw = JSON.parse(await fs.readFile(CatalogCache.fileFor(HUB, dir), "utf8"))
    expect(raw.version).toBe("1")
    expect(await CatalogCache.read(HUB, dir).then((entry) => entry?.version)).toBe("1")
  })

  test("AC-158: модель прав неизвестного вида хранится в кэше дословно", async () => {
    const dir = await dataDir()
    const quota = { kind: "quota_tiers", tiers: [{ id: "basic", calls: 100 }], note: "форма следующей версии" }
    const card = liveTagCard()
    card["permission_model"] = quota
    const parsed = CorpSchema.parseCatalog({ version: 1, servers: [card] })
    if (!parsed) throw new Error("конверт должен быть разобран")

    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 42, version: parsed.version, servers: parsed.servers }, dir)

    // Иначе следующая версия приложения увидела бы обеднённый кэш вместо исходных данных Hub (S-V3).
    const raw = JSON.parse(await fs.readFile(CatalogCache.fileFor(HUB, dir), "utf8"))
    expect(raw.servers[0].permission_model).toEqual(quota)
    const entry = await CatalogCache.read(HUB, dir)
    expect(entry?.servers[0]!.permission_model).toEqual(quota)
    expect(entry?.servers.map((server) => server.alias)).toEqual(["tag"])
  })

  test("AC-158: живая модель tool_filter переживает запись и чтение кэша без потерь", async () => {
    const dir = await dataDir()
    const parsed = CorpSchema.parseCatalog(liveCatalogBody())
    if (!parsed) throw new Error("конверт должен быть разобран")

    await CatalogCache.write({ hubUrl: HUB, fetchedAt: 42, version: parsed.version, servers: parsed.servers }, dir)
    const entry = await CatalogCache.read(HUB, dir)

    expect(entry?.servers[0]!.permission_model).toEqual(liveTagCard()["permission_model"])
    const model = CorpSchema.parsePermissionModel(entry?.servers[0]!.permission_model)
    if (model?.kind !== "tool_filter") throw new Error("ожидалась модель tool_filter")
    expect(model.presets["readonly"]!.tools).toEqual(
      (liveTagCard()["permission_model"] as { presets: Record<string, { tools: string[] }> }).presets["readonly"]!
        .tools,
    )
  })
})
