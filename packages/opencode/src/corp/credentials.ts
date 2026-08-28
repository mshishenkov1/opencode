import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import * as CorpCatalog from "./catalog"
import * as CorpCatalogCache from "./catalog-cache"
import { corpCatalogUrl, corpHubUrl } from "./config"
import * as CorpSchema from "./schema"

/**
 * Хранилище учётных данных коннекторов прямого режима (S-V26, ревизия 1.13).
 *
 * Отдельный файл `Global.Path.data/corp/connector-credentials.json` с правами `0o600` — рядом с
 * `auth.json` (ключ корпоративного SSO), `mcp-auth.json` и кэшами, и **того же класса защиты**, что
 * уже несёт ключ SSO. Защищённым хранилищем **операционной системы** (Keychain, DPAPI, Secret
 * Service) он не является, и правило это не скрывает: серверная часть, которая одна и создаёт
 * транспорт, — отдельный процесс bun без доступа к Electron API (F67), а цена и границы выбора
 * названы решением D-58 и микроревизией 1.13.1.
 *
 * Токена нет ни в одном файле конфигурации (S-V26 п.2): подстановка выполняется **в момент создания
 * транспорта** (п.4, D-60), а не записью в `mcp.<alias>.headers`.
 *
 * Модуль намеренно написан на промисах и не зависит от Effect: его зовут и корп-роут, и шов
 * подстановки заголовков в `mcp/index.ts`.
 */

/** Имя файла хранилища (S-V26 п.1). Каталог данных один на все платформы (F66). */
export function file(dataDir: string = Global.Path.data) {
  return path.join(dataDir, "corp", "connector-credentials.json")
}

/**
 * Запись об одном подключённом alias (S-V26 п.1).
 *
 * `issued: true` — токен получен обменом (S-V25 п.5) и приложение вправе его отозвать;
 * `issued: false` — токен ввёл пользователь, и отзывать его приложение не будет (S-V27 п.3).
 *
 * `credential_headers` и `static_headers` — **шаблоны** заголовков карточки на момент сохранения
 * (`{{access_token}}` в них не подставлен, секрета в них нет). Они лежат здесь, чтобы шов создания
 * транспорта (п.4) собирал набор заголовков **одним** чтением и работал даже тогда, когда кэш
 * каталога отсутствует или уже переписан другим источником. Действующий каталог при этом сильнее:
 * шаблоны из него, если карточка в кэше есть, побеждают сохранённые.
 */
export interface Record_ {
  upstream_url: string
  method_id: string
  token: string
  token_id?: string
  issued: boolean
  account?: string
  saved_at: string
  credential_headers?: Record<string, string>
  static_headers?: Record<string, string>
}

export type Store = Record<string, Record_>

export interface ReadResult {
  store: Store
  /**
   * Файл есть, но прочитать его не удалось: битый JSON или чужая форма (S-V26 п.5, второй случай).
   * Трактуется как «учётных данных нет»; файл **не удаляется** и перезаписывается только следующим
   * успешным сохранением.
   */
  corrupted: boolean
}

/** Итог записи (S-V26 п.5). Отказ прав — **не** отказ хранения: `chmodFailed` записи не отменяет. */
export type WriteResult = { ok: true; chmodFailed: boolean } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Разбор содержимого файла. Форма проверяется вручную, а не схемой: любое отклонение здесь
 * означает «записи нет», и различать виды поломки незачем — файл всё равно будет перезаписан.
 */
function parse(value: unknown): Store | undefined {
  if (!isRecord(value)) return undefined
  const store: Store = {}
  for (const [alias, entry] of Object.entries(value)) {
    if (!alias || !isRecord(entry)) continue
    const url = entry["upstream_url"]
    const methodId = entry["method_id"]
    const token = entry["token"]
    const savedAt = entry["saved_at"]
    if (typeof url !== "string" || url === "") continue
    if (typeof methodId !== "string" || methodId === "") continue
    if (typeof token !== "string" || token === "") continue
    const tokenId = entry["token_id"]
    const account = entry["account"]
    const credentialHeaders = isRecord(entry["credential_headers"])
      ? headerMapOf(entry["credential_headers"])
      : undefined
    const staticHeaders = isRecord(entry["static_headers"]) ? headerMapOf(entry["static_headers"]) : undefined
    store[alias] = {
      upstream_url: url,
      method_id: methodId,
      token,
      ...(typeof tokenId === "string" && tokenId !== "" ? { token_id: tokenId } : {}),
      issued: entry["issued"] === true,
      ...(typeof account === "string" && account !== "" ? { account } : {}),
      saved_at: typeof savedAt === "string" ? savedAt : "",
      ...(credentialHeaders === undefined ? {} : { credential_headers: credentialHeaders }),
      ...(staticHeaders === undefined ? {} : { static_headers: staticHeaders }),
    }
  }
  return store
}

function headerMapOf(value: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) if (name !== "" && typeof entry === "string") headers[name] = entry
  return headers
}

/** Читает хранилище; отсутствие файла — пустой набор без пометки о повреждении (S-V26 п.5). */
export async function read(dataDir?: string): Promise<ReadResult> {
  let text: string
  try {
    text = await fs.readFile(file(dataDir), "utf8")
  } catch {
    return { store: {}, corrupted: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { store: {}, corrupted: true }
  }
  const store = parse(parsed)
  if (!store) return { store: {}, corrupted: true }
  return { store, corrupted: false }
}

/**
 * Перезаписывает файл хранилища; права — `0o600` (S-V26 п.1).
 *
 * Отказ записи **фатален** для действия (п.5, первый случай) — в отличие от кэша каталога и
 * признака подключений, где он не фатален: карточка, объявленная подключённой без сохранённого
 * токена, подключиться уже не сможет и будет врать пользователю при каждом запуске. Отказ `chmod`
 * (Windows, экзотическая ФС) записи **не** отменяет и возвращается отдельным признаком.
 */
export async function write(store: Store, dataDir?: string): Promise<WriteResult> {
  const target = file(dataDir)
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, JSON.stringify(store), { mode: 0o600 })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  let chmodFailed = false
  // На Windows `fs.chmod` переключает только признак «только чтение» — это ограничение платформы,
  // а не выбор форка, и неуспех прав записи не отменяет (S-V26 п.1, п.5 третий случай).
  await fs.chmod(target, 0o600).catch(() => {
    chmodFailed = true
  })
  return { ok: true, chmodFailed }
}

/** Сохраняет запись одного alias, не трогая записи прочих коннекторов (S-V26 п.1). */
export async function save(alias: string, record: Record_, dataDir?: string): Promise<WriteResult> {
  const current = await read(dataDir)
  return write({ ...current.store, [alias]: record }, dataDir)
}

/**
 * Удаляет запись ровно этого alias (S-V27 п.3); записи прочих коннекторов не трогаются.
 * Удаление — обязательство, поэтому выполняется независимо от исхода отзыва.
 */
export async function remove(alias: string, dataDir?: string): Promise<WriteResult | undefined> {
  const current = await read(dataDir)
  if (current.store[alias] === undefined && !current.corrupted) return undefined
  const next: Store = { ...current.store }
  delete next[alias]
  return write(next, dataDir)
}

/**
 * Применима ли запись к действующему адресу карточки (S-V26 п.3): `upstream_url` записи
 * **посимвольно равен** адресу. Каталог сменил адрес сервера — запись перестаёт применяться, и
 * токен, выданный одним сервером, не отправляется другому (та же привязка, что у `mcp-auth.json`).
 */
export function applicable(record: Record_ | undefined, upstreamUrl: string | undefined): boolean {
  if (!record || upstreamUrl === undefined) return false
  return record.upstream_url === upstreamUrl
}

/**
 * Итоговый набор заголовков запроса к MCP-серверу (S-V26 п.4).
 *
 * Порядок источников — `static → config → credential`, и **последний побеждает** при совпадении
 * имён: учётный заголовок побеждает всегда, потому что значение того же имени, оказавшееся в
 * конфиге, — заведомо не действующий токен, и подставлять его вместо настоящего нельзя. Имена
 * сравниваются без учёта регистра: HTTP их так и трактует, и `Authorization` из конфига не должен
 * ужиться рядом с `authorization` учётного набора.
 */
export function mergeHeaders(input: {
  static?: Record<string, string> | undefined
  config?: Record<string, string> | undefined
  credential?: Record<string, string> | undefined
  token?: string
}): Record<string, string> {
  const result: Record<string, string> = {}
  const byLowerName = new Map<string, string>()
  const put = (name: string, value: string) => {
    const previous = byLowerName.get(name.toLowerCase())
    if (previous !== undefined) delete result[previous]
    byLowerName.set(name.toLowerCase(), name)
    result[name] = value
  }
  for (const [name, value] of Object.entries(input.static ?? {})) put(name, value)
  for (const [name, value] of Object.entries(input.config ?? {})) put(name, value)
  const values: Record<string, string> = input.token === undefined ? {} : { access_token: input.token }
  for (const [name, value] of Object.entries(input.credential ?? {})) put(name, CorpSchema.substitute(value, values))
  return result
}

/**
 * Шаблоны заголовков **действующего** каталога для alias (S-V26 п.4).
 *
 * Кэш каталога хранит `upstream` дословно (S-V3, S-V24 п.5), поэтому источник шаблонов здесь тот
 * же, что у витрины. Кэша нет или карточка из него ушла — шов берёт шаблоны, сохранённые вместе с
 * записью: подключение, которое уже работает, не должно отваливаться из-за пропавшего кэша.
 */
async function catalogUpstream(alias: string): Promise<CorpSchema.ParsedUpstream | undefined> {
  const sources = CorpCatalog.sources({
    ...(corpCatalogUrl() === undefined ? {} : { catalogUrl: corpCatalogUrl()! }),
    ...(corpHubUrl() === undefined ? {} : { hubUrl: corpHubUrl()! }),
  })
  for (const source of sources) {
    const cached = await CorpCatalogCache.read(source.url).catch(() => undefined)
    const server = cached?.servers.find((entry) => entry.alias === alias)
    if (!server) continue
    const upstream = CorpSchema.parseUpstream(server.upstream)
    if (upstream) return upstream
  }
  return undefined
}

/**
 * Заголовки запроса к MCP-серверу для alias (S-V26 п.4, D-60) — **единственная** точка подстановки.
 *
 * Возвращает заголовки конфига без изменений, если применимой записи нет: подстановка учётных
 * заголовков — свойство прямого подключения, а не всех удалённых серверов пользователя. Значение
 * токена в лог, события и ответы роутов отсюда не уходит (S-V26 п.6).
 */
export async function requestHeaders(
  alias: string,
  url: string,
  configHeaders?: Record<string, string> | undefined,
  dataDir?: string,
): Promise<Record<string, string> | undefined> {
  const { store } = await read(dataDir).catch(() => ({ store: {} as Store, corrupted: true }))
  const record = store[alias]
  // S-V26 п.3: запись применима только при посимвольном совпадении адреса. Не совпал — заголовки
  // не подставляются вовсе, и карточка переходит в «нужно ввести токен заново».
  if (!record || !applicable(record, url)) return configHeaders
  const upstream = await catalogUpstream(alias).catch(() => undefined)
  const fromCatalog = upstream?.url === url ? upstream : undefined
  const credential = fromCatalog ? fromCatalog.credential_headers : record.credential_headers
  const staticHeaders = fromCatalog ? fromCatalog.static_headers : record.static_headers
  if (!credential || Object.keys(credential).length === 0) return configHeaders
  return mergeHeaders({
    static: staticHeaders,
    config: configHeaders,
    credential,
    token: record.token,
  })
}
