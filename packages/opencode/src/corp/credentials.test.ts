import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import * as CatalogCache from "./catalog-cache"
import * as CorpCredentials from "./credentials"
import * as CorpSchema from "./schema"

/**
 * Хранилище учётных данных прямого подключения (S-V26, ревизия 1.13; AC-321…AC-325, AC-330, AC-347).
 *
 * Модуль на промисах без Effect (см. `credentials.ts`) — тестируется напрямую, без HTTP-роута:
 * файл хранилища и файл кэша каталога подменяются временными.
 */

const dirs: string[] = []
async function dataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corp-credentials-"))
  dirs.push(dir)
  return dir
}

let previousCatalogUrl: string | undefined
let previousHubUrl: string | undefined
let previousGlobalData: string | undefined

afterEach(async () => {
  while (dirs.length) await fs.chmod(dirs[dirs.length - 1]!, 0o700).catch(() => {}).then(() => fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {}))
  if (previousCatalogUrl === undefined) delete process.env["OPENCODE_CORP_CATALOG_URL"]
  else process.env["OPENCODE_CORP_CATALOG_URL"] = previousCatalogUrl
  if (previousHubUrl === undefined) delete process.env["OPENCODE_CORP_HUB_URL"]
  else process.env["OPENCODE_CORP_HUB_URL"] = previousHubUrl
  previousCatalogUrl = undefined
  previousHubUrl = undefined
  if (previousGlobalData !== undefined) {
    ;(Global.Path as { data: string }).data = previousGlobalData
    previousGlobalData = undefined
  }
})

/**
 * `catalogUpstream()` (внутренний шаг `requestHeaders`) читает кэш каталога по `Global.Path.data`
 * умолчанию — параметра `dataDir` у него нет, в отличие от самого хранилища учётных данных. Тесты
 * AC-347 подменяют `Global.Path.data` тем же временным каталогом, что передан в `save`/`requestHeaders`.
 */
function useGlobalData(dir: string) {
  previousGlobalData = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
}

const MARKER = "MARKER-cred-test-token"

const record = (overrides: Partial<CorpCredentials.Record_> = {}): CorpCredentials.Record_ => ({
  upstream_url: "https://target.test/mcp",
  method_id: "personal_token",
  token: MARKER,
  issued: false,
  saved_at: "2026-08-28T00:00:00.000Z",
  ...overrides,
})

describe("corp/credentials — запись и чтение (S-V26 п.1; AC-321)", () => {
  test("AC-321: save() кладёт файл connector-credentials.json с полями записи; POSIX-права 0o600", async () => {
    const dir = await dataDir()
    const result = await CorpCredentials.save("svc", record(), dir)
    expect(result.ok).toBe(true)

    const file = CorpCredentials.file(dir)
    expect(file).toBe(path.join(dir, "corp", "connector-credentials.json"))
    const raw = JSON.parse(await fs.readFile(file, "utf8"))
    expect(raw["svc"]).toMatchObject({
      upstream_url: "https://target.test/mcp",
      method_id: "personal_token",
      token: MARKER,
      issued: false,
      saved_at: "2026-08-28T00:00:00.000Z",
    })

    if (process.platform !== "win32") {
      const stat = await fs.stat(file)
      expect(stat.mode & 0o777).toBe(0o600)
    }

    const { store } = await CorpCredentials.read(dir)
    expect(store["svc"]).toEqual(record())
  })

  test("AC-321: сохранение alias не трогает записи прочих коннекторов", async () => {
    const dir = await dataDir()
    await CorpCredentials.save("a", record({ upstream_url: "https://a.test/mcp" }), dir)
    await CorpCredentials.save("b", record({ upstream_url: "https://b.test/mcp" }), dir)
    const { store } = await CorpCredentials.read(dir)
    expect(Object.keys(store).sort()).toEqual(["a", "b"])
  })
})

describe("corp/credentials — привязка к alias и адресу (S-V26 п.3; AC-322)", () => {
  test("AC-322: upstream_url записи не равен действующему upstream.url — запись НЕ применима", () => {
    const stored = record({ upstream_url: "https://a.example/mcp" })
    expect(CorpCredentials.applicable(stored, "https://b.example/mcp")).toBe(false)
    expect(CorpCredentials.applicable(stored, "https://a.example/mcp")).toBe(true)
    expect(CorpCredentials.applicable(undefined, "https://a.example/mcp")).toBe(false)
    expect(CorpCredentials.applicable(stored, undefined)).toBe(false)
  })

  test("AC-322: requestHeaders не подставляет учётные заголовки, если запись неприменима к новому адресу", async () => {
    const dir = await dataDir()
    await CorpCredentials.save("svc", record({ upstream_url: "https://a.example/mcp" }), dir)

    const headers = await CorpCredentials.requestHeaders("svc", "https://b.example/mcp", undefined, dir)
    // Адрес сменился — заголовки конфига возвращаются БЕЗ ИЗМЕНЕНИЯ (undefined здесь), учётный
    // заголовок не подставлен ни разу.
    expect(headers).toBeUndefined()
  })
})

describe("corp/credentials — сборка заголовков: порядок и регистр (S-V26 п.4; AC-323, AC-347)", () => {
  test("AC-323: порядок static → config → credential; учётный заголовок побеждает конфиг", () => {
    const merged = CorpCredentials.mergeHeaders({
      static: { "X-Src": "catalog" },
      config: { "X-Src": "user", Authorization: "Bearer stale" },
      credential: { Authorization: "Bearer {{access_token}}" },
      token: MARKER,
    })
    expect(merged["X-Src"]).toBe("user") // конфиг победил каталог
    expect(merged["Authorization"]).toBe(`Bearer ${MARKER}`) // учётный заголовок победил конфиг
    expect(JSON.stringify(merged)).not.toContain("stale")
  })

  test("AC-347: имена заголовков сравниваются БЕЗ УЧЁТА РЕГИСТРА — учётный заголовок побеждает всегда", () => {
    const merged = CorpCredentials.mergeHeaders({
      config: { authorization: "Bearer stale-lowercase" },
      credential: { Authorization: "Bearer {{access_token}}" },
      token: MARKER,
    })
    // Регистр расходится (`authorization` в конфиге vs `Authorization` в credential) — побеждает
    // РОВНО ОДНА запись с учётным значением; старой не осталось ни под каким именем.
    const keys = Object.keys(merged)
    expect(keys).toHaveLength(1)
    expect(merged[keys[0]!]).toBe(`Bearer ${MARKER}`)
    expect(JSON.stringify(merged)).not.toContain("stale-lowercase")
  })

  test("AC-347: requestHeaders — заголовки из кэша каталога, когда он есть", async () => {
    const dir = await dataDir()
    previousCatalogUrl = process.env["OPENCODE_CORP_CATALOG_URL"]
    previousHubUrl = process.env["OPENCODE_CORP_HUB_URL"]
    const catalogUrl = "https://static.test/catalog"
    process.env["OPENCODE_CORP_CATALOG_URL"] = catalogUrl
    delete process.env["OPENCODE_CORP_HUB_URL"]
    useGlobalData(dir)

    await CorpCredentials.save(
      "svc",
      record({
        upstream_url: "https://target.test/mcp",
        // Шаблоны, сохранённые ПРИ подключении — устарели относительно кэша ниже, и это доказывает,
        // что при наличии кэша используются именно его шаблоны, а не сохранённые.
        credential_headers: { Authorization: "Bearer stale-template-{{access_token}}" },
      }),
      dir,
    )
    const server: CorpSchema.CatalogServer = {
      alias: "svc",
      title: "Служба",
      mode: "facade",
      mcp_url: "https://hub.test/mcp/svc",
      upstream: {
        url: "https://target.test/mcp",
        credential_headers: { Authorization: "Bearer {{access_token}}" },
        static_headers: { "X-Src": "catalog" },
      },
    }
    await CatalogCache.write({ hubUrl: catalogUrl, fetchedAt: Date.now(), version: "v1", servers: [server] }, dir)

    const headers = await CorpCredentials.requestHeaders("svc", "https://target.test/mcp", { "X-User": "1" }, dir)
    expect(headers).toEqual({ "X-User": "1", "X-Src": "catalog", Authorization: `Bearer ${MARKER}` })
  })

  test("AC-347: requestHeaders — кэш каталога удалён, шаблоны берутся из сохранённой записи", async () => {
    const dir = await dataDir()
    previousCatalogUrl = process.env["OPENCODE_CORP_CATALOG_URL"]
    previousHubUrl = process.env["OPENCODE_CORP_HUB_URL"]
    process.env["OPENCODE_CORP_CATALOG_URL"] = "https://static.test/catalog"
    delete process.env["OPENCODE_CORP_HUB_URL"]
    useGlobalData(dir)
    // Кэша каталога в этом каталоге данных нет вовсе — подключение, которое уже работает, не
    // должно отваливаться из-за пропавшего кэша.

    await CorpCredentials.save(
      "svc",
      record({
        upstream_url: "https://target.test/mcp",
        credential_headers: { authorization: "Bearer {{access_token}}" },
        static_headers: { "X-Src": "record" },
      }),
      dir,
    )

    const headers = await CorpCredentials.requestHeaders("svc", "https://target.test/mcp", undefined, dir)
    expect(headers).toEqual({ "X-Src": "record", authorization: `Bearer ${MARKER}` })
  })
})

describe("corp/credentials — хранилище недоступно (S-V26 п.5; AC-324, AC-325)", () => {
  test("AC-324: запись не удалась (каталог для файла недоступен для записи) — отказ, а не тихая потеря", async () => {
    if (process.platform === "win32") return // fs.chmod на Windows переключает только read-only
    const dir = await dataDir()
    await fs.chmod(dir, 0o500) // нет прав на создание вложенного каталога corp/
    const result = await CorpCredentials.save("svc", record(), dir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.error).toBeTruthy()
    await fs.chmod(dir, 0o700) // вернуть права, иначе cleanup откажет тем же способом
  })

  test("AC-325: файл хранилища с битым JSON — трактуется как «учётных данных нет», не удаляется", async () => {
    const dir = await dataDir()
    const file = CorpCredentials.file(dir)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{not valid json", { mode: 0o600 })

    const result = await CorpCredentials.read(dir)
    expect(result.corrupted).toBe(true)
    expect(result.store).toEqual({})
    // Файл НЕ удалён — перезаписывается только следующим успешным сохранением.
    const stillThere = await fs.readFile(file, "utf8")
    expect(stillThere).toBe("{not valid json")

    // Следующее успешное сохранение перезаписывает файл.
    await CorpCredentials.save("svc", record(), dir)
    const after = await CorpCredentials.read(dir)
    expect(after.corrupted).toBe(false)
    expect(after.store["svc"]).toEqual(record())
  })

  test("AC-325: чтение отсутствующего файла — пустой набор БЕЗ пометки о повреждении", async () => {
    const dir = await dataDir()
    const result = await CorpCredentials.read(dir)
    expect(result).toEqual({ store: {}, corrupted: false })
  })
})

describe("corp/credentials — удаление записи (S-V27 п.3)", () => {
  test("remove() удаляет ровно один alias, прочие записи не тронуты", async () => {
    const dir = await dataDir()
    await CorpCredentials.save("a", record(), dir)
    await CorpCredentials.save("b", record(), dir)
    await CorpCredentials.remove("a", dir)
    const { store } = await CorpCredentials.read(dir)
    expect(Object.keys(store)).toEqual(["b"])
  })
})
