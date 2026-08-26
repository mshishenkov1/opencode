import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { Option, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import * as CorpSchema from "./schema"

/**
 * Кэш каталога коннекторов на диске (S-V3, D-12).
 *
 * Кэш — только деградация: витрина всегда пытается сходить к источнику, а TTL 24 ч управляет не
 * «когда обновлять», а «когда данные считать протухшими».
 *
 * **Ревизия 1.11 (S-V3, S-C10 п.3).** Кэш наполняет успешный ответ **любого** источника каталога —
 * и Hub, и статического адреса, — а файл ключуется адресом **того источника, из которого каталог
 * получен**. Смена источника или адреса не смешивает два каталога в одном файле и не «оживляет»
 * записи прежнего стенда. Имя поля `hub_url` в содержимом сохранено как есть: это формат файла на
 * дисках пользователей, и его значение теперь — адрес источника.
 */

export const TTL_MS = 24 * 60 * 60 * 1000

/** Файл кэша по адресу источника каталога (S-V3, S-C10 п.3). */
export function fileFor(sourceUrl: string, dataDir: string = Global.Path.data) {
  const digest = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)
  return path.join(dataDir, "corp", `catalog-${digest}.json`)
}

export interface Entry {
  /** Адрес источника, из которого каталог получен (S-C10 п.3): адрес Hub или статического каталога. */
  hubUrl: string
  fetchedAt: number
  version: string
  servers: CorpSchema.CatalogServer[]
}

/** Читает кэш по адресу источника; повреждённый или чужой файл трактуется как отсутствие кэша. */
export async function read(sourceUrl: string, dataDir?: string): Promise<Entry | undefined> {
  const hubUrl = sourceUrl
  const file = fileFor(hubUrl, dataDir)
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const decoded = Schema.decodeUnknownOption(CorpSchema.CatalogCacheFile)(parsed)
  if (Option.isNone(decoded)) return undefined
  const value = decoded.value
  if (value.hub_url !== hubUrl) return undefined
  // Карточки кэша проходят тот же поэлементный разбор, что и ответ Hub (S-V14): файл, записанный
  // другой версией клиента, не отбрасывается целиком из-за одной непонятой карточки.
  const servers: CorpSchema.CatalogServer[] = []
  for (const entry of value.servers) {
    const server = CorpSchema.parseCatalogServer(entry)
    if (server.ok) servers.push(server.server)
  }
  return { hubUrl: value.hub_url, fetchedAt: value.fetched_at, version: value.version, servers }
}

/**
 * Перезаписывает кэш; права файла — `0o600`. Ошибка записи не считается фатальной.
 *
 * Пишутся только карточки, **принятые** разбором (S-V3, S-V14): отброшенные не сохраняются и не
 * «оживают» из кэша. `permission_model`, `permission_groups` и `type` каждой карточки уходят на
 * диск дословно, как пришли от источника.
 *
 * Ответ, не прошедший разбор конверта, сюда не доходит вовсе (S-C10 п.5, D-42): единственная запись
 * в кэш — успешно разобранный ответ, поэтому одна опечатка в статическом файле не стирает у
 * пользователя последний рабочий каталог.
 */
export async function write(entry: Entry, dataDir?: string): Promise<void> {
  const file = fileFor(entry.hubUrl, dataDir)
  const body: CorpSchema.CatalogCacheFile = {
    hub_url: entry.hubUrl,
    fetched_at: entry.fetchedAt,
    version: entry.version,
    servers: entry.servers,
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(body), { mode: 0o600 })
    await fs.chmod(file, 0o600).catch(() => {})
  } catch {
    // Кэш — необязательная оптимизация: невозможность записи не должна ломать витрину.
  }
}

/** Протух ли кэш по TTL (S-V3). */
export function isStale(entry: Entry, now: number, ttlMs: number = TTL_MS) {
  return now - entry.fetchedAt > ttlMs
}
