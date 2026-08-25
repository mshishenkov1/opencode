import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as CorpConnections from "./connections"

/**
 * Признак «подключение состоялось» (S-V15, D-30; AC-179, AC-188).
 *
 * Признак различает сервер, к которому пользователь никогда не подключался, и сервер, подключение
 * которого было и сломалось: от этого различия зависит набор действий карточки (S-V16). Проверяется
 * наблюдаемое поведение файла-артефакта — что в нём оказывается, с какими правами, что происходит
 * при повреждении и что признак снимает.
 *
 * Сети нет, настоящий `Global.Path.data` не задействован: каталог данных передаётся параметром.
 *
 * Запуск: `bun --cwd packages/opencode test src/corp/connections.test.ts`.
 */

const dirs: string[] = []

async function dataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corp-connections-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

const HUB = "https://hub.magnit.test"
const OTHER_HUB = "https://hub.other.test"

describe("corp/connections — хранение признака (S-V15 п.2; AC-188)", () => {
  test("AC-188: наблюдение по локальному connected записывается и переживает перезапуск", async () => {
    const dir = await dataDir()
    const first = await CorpConnections.read(HUB, dir)
    expect(first.corrupted).toBe(false)
    expect(CorpConnections.has(first.entry, "gitlab")).toBe(false)

    const next = CorpConnections.remember(first.entry, ["gitlab"])
    expect(next).toBeDefined()
    await CorpConnections.write(next!, dir)

    // «Перезапуск приложения» — повторное чтение того же каталога данных новым вызовом.
    const reopened = await CorpConnections.read(HUB, dir)
    expect(reopened.corrupted).toBe(false)
    expect(CorpConnections.has(reopened.entry, "gitlab")).toBe(true)
    expect(typeof reopened.entry.aliases["gitlab"]!.connected_at).toBe("string")
  })

  test("S-V15 п.2: файл признака имеет права 0o600", async () => {
    const dir = await dataDir()
    const { entry } = await CorpConnections.read(HUB, dir)
    await CorpConnections.write(CorpConnections.remember(entry, ["gitlab"])!, dir)

    const file = CorpConnections.fileFor(HUB, dir)
    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("S-V15 п.2: содержимое файла — hub_url и connected_at по каждому alias", async () => {
    const dir = await dataDir()
    const { entry } = await CorpConnections.read(HUB, dir)
    await CorpConnections.write(CorpConnections.remember(entry, ["gitlab", "tag"])!, dir)

    const body = JSON.parse(await fs.readFile(CorpConnections.fileFor(HUB, dir), "utf8"))
    expect(body.hub_url).toBe(HUB)
    expect(Object.keys(body.aliases).sort()).toEqual(["gitlab", "tag"])
    expect(typeof body.aliases.gitlab.connected_at).toBe("string")
    expect(Date.parse(body.aliases.gitlab.connected_at)).not.toBeNaN()
  })

  test("S-V15 п.2: connected_at первого наблюдения повторные подключения не меняют", async () => {
    const dir = await dataDir()
    const start = new Date("2026-01-01T00:00:00.000Z")
    const first = CorpConnections.remember({ hubUrl: HUB, aliases: {} }, ["gitlab"], start)!
    await CorpConnections.write(first, dir)

    const again = CorpConnections.remember(first, ["gitlab"], new Date("2026-06-01T00:00:00.000Z"))
    // Писать нечего — файл не трогается вовсе.
    expect(again).toBeUndefined()
    const reopened = await CorpConnections.read(HUB, dir)
    expect(reopened.entry.aliases["gitlab"]!.connected_at).toBe(start.toISOString())
  })

  test("S-V15 п.2: кэши разных hub_url изолированы", async () => {
    const dir = await dataDir()
    await CorpConnections.write(CorpConnections.remember({ hubUrl: HUB, aliases: {} }, ["gitlab"])!, dir)

    expect(CorpConnections.fileFor(OTHER_HUB, dir)).not.toBe(CorpConnections.fileFor(HUB, dir))
    const other = await CorpConnections.read(OTHER_HUB, dir)
    expect(other.corrupted).toBe(false)
    expect(CorpConnections.has(other.entry, "gitlab")).toBe(false)
  })

  test("S-V15 п.2: файл чужого Hub не принимается за свой", async () => {
    const dir = await dataDir()
    const file = CorpConnections.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ hub_url: OTHER_HUB, aliases: { gitlab: { connected_at: "2026-01-01" } } }))

    const result = await CorpConnections.read(HUB, dir)
    expect(result.corrupted).toBe(true)
    expect(CorpConnections.has(result.entry, "gitlab")).toBe(false)
  })
})

describe("corp/connections — отсутствие и повреждение файла (S-V15 п.4; AC-179)", () => {
  test("AC-179: файла нет — признак ложен, повреждением это не считается", async () => {
    const dir = await dataDir()
    const result = await CorpConnections.read(HUB, dir)
    expect(result.corrupted).toBe(false)
    expect(result.entry.aliases).toEqual({})
    expect(CorpConnections.has(result.entry, "gitlab")).toBe(false)
  })

  test("AC-179: повреждённый файл трактуется как отсутствующий и помечается для лога", async () => {
    const dir = await dataDir()
    const file = CorpConnections.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })

    for (const broken of ["{не json", "[]", '"строка"', JSON.stringify({ hub_url: HUB, aliases: [] })]) {
      await fs.writeFile(file, broken)
      const result = await CorpConnections.read(HUB, dir)
      expect(result.corrupted, broken).toBe(true)
      expect(result.entry.aliases, broken).toEqual({})
    }
  })

  test("AC-179: повреждённый файл перезаписывается при следующей записи", async () => {
    const dir = await dataDir()
    const file = CorpConnections.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{не json")

    const { entry } = await CorpConnections.read(HUB, dir)
    await CorpConnections.write(CorpConnections.remember(entry, ["gitlab"])!, dir)

    const reopened = await CorpConnections.read(HUB, dir)
    expect(reopened.corrupted).toBe(false)
    expect(CorpConnections.has(reopened.entry, "gitlab")).toBe(true)
  })

  test("AC-179: битые записи внутри целого файла отбрасываются поэлементно", async () => {
    const dir = await dataDir()
    const file = CorpConnections.fileFor(HUB, dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({
        hub_url: HUB,
        aliases: {
          gitlab: { connected_at: "2026-01-01T00:00:00.000Z" },
          jira: { connected_at: 17 },
          wiki: null,
          s3: {},
        },
      }),
    )

    const result = await CorpConnections.read(HUB, dir)
    expect(result.corrupted).toBe(false)
    expect(Object.keys(result.entry.aliases)).toEqual(["gitlab"])
  })
})

describe("corp/connections — что считается состоявшимся подключением (S-V15 п.1; AC-179)", () => {
  test("AC-179: признак истинен по данным Hub даже без файла", () => {
    expect(CorpConnections.provenByHub("connected")).toBe(true)
    expect(CorpConnections.provenByHub("needs_reauth")).toBe(true)
    expect(CorpConnections.observed({ connection: "connected" })).toBe(true)
    expect(CorpConnections.observed({ connection: "needs_reauth" })).toBe(true)
  })

  test("AC-179: без файла и без connection признак ложен", async () => {
    const dir = await dataDir()
    const { entry } = await CorpConnections.read(HUB, dir)
    expect(CorpConnections.has(entry, "gitlab")).toBe(false)
    expect(CorpConnections.observed({})).toBe(false)
    expect(CorpConnections.observed({ local: "failed" })).toBe(false)
    expect(CorpConnections.observed({ local: "needs_auth" })).toBe(false)
    expect(CorpConnections.observed({ local: "disabled" })).toBe(false)
  })

  test("S-V15 п.1: локальный connected — доказательство, прочие локальные статусы — нет", () => {
    expect(CorpConnections.observed({ local: "connected" })).toBe(true)
    expect(CorpConnections.observed({ local: "needs_client_registration" })).toBe(false)
    expect(CorpConnections.provenByHub(undefined)).toBe(false)
  })
})

describe("corp/connections — снятие признака (S-V15 п.3; AC-188)", () => {
  test("AC-188: forget снимает признак ровно с одного alias", async () => {
    const dir = await dataDir()
    const remembered = CorpConnections.remember({ hubUrl: HUB, aliases: {} }, ["gitlab", "tag"])!
    await CorpConnections.write(remembered, dir)

    const without = CorpConnections.forget(remembered, "gitlab")
    expect(without).toBeDefined()
    await CorpConnections.write(without!, dir)

    const reopened = await CorpConnections.read(HUB, dir)
    expect(CorpConnections.has(reopened.entry, "gitlab")).toBe(false)
    expect(CorpConnections.has(reopened.entry, "tag")).toBe(true)
  })

  test("AC-188: снятие признака у alias без записи ничего не меняет", () => {
    const entry = CorpConnections.remember({ hubUrl: HUB, aliases: {} }, ["tag"])!
    expect(CorpConnections.forget(entry, "gitlab")).toBeUndefined()
    expect(CorpConnections.has(entry, "tag")).toBe(true)
  })
})
