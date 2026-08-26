import * as CorpSchema from "./schema"

/**
 * Источники каталога коннекторов (S-C10 п.3, D-40, D-41).
 *
 * Каталог перестал быть свойством Hub: это список записей, который раздаётся статическим файлом с
 * того же внутреннего хоста, что фид обновлений. Порядок источников фиксирован —
 * статический адрес → Hub → дисковый кэш, — и при обоих заданных адресах статический сильнее:
 * сборка переходного периода обязана вести себя как сборка целевого состояния.
 *
 * Второго парсера каталога здесь нет (D-41): тело статического источника разбирает тот же
 * `parseCatalog` и те же три уровня S-V14, что и ответ Hub.
 */

export const REQUEST_TIMEOUT_MS = 5000

/** Порядок источников каталога (S-C10 п.3). Источник с незаданным адресом пропускается целиком. */
export type SourceKind = "static" | "hub"

export interface Source {
  kind: SourceKind
  url: string
}

/**
 * Список источников в порядке проб (S-C10 п.3).
 *
 * Незаданный адрес — не «источник, который не ответил», а отсутствие источника: он не пробуется и
 * не даёт ни ошибки, ни записи в лог.
 */
export function sources(input: { catalogUrl?: string; hubUrl?: string }): Source[] {
  const list: Source[] = []
  if (input.catalogUrl) list.push({ kind: "static", url: input.catalogUrl })
  if (input.hubUrl) list.push({ kind: "hub", url: input.hubUrl })
  return list
}

/**
 * Причина отказа статического источника (S-C10 п.5).
 *
 * Различаются ровно два случая, потому что они по-разному выглядят в логе: «не дозвонились или
 * ответ не 2xx» и «ответ получен, но конверт не разобран». Оба переводят выбор на следующий
 * источник и **ни один** не пишется в кэш (D-42).
 */
export type StaticFailure =
  | { reason: "unreachable" }
  | { reason: "http_status"; status: number }
  | { reason: "invalid_envelope" }

export type StaticResult =
  | {
      ok: true
      version: string
      servers: CorpSchema.CatalogServer[]
      dropped: CorpSchema.Dropped[]
    }
  | ({ ok: false } & StaticFailure)

export interface FetchOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * `GET <CATALOG_URL>` — тело того же вида, что конверт `GET /api/catalog` (S-C10 п.4).
 *
 * Заголовка `Authorization` нет и быть не может: статический источник запрашивается **без** ключа
 * `magnit_prod` (S-C10 п.6), и отсутствие записи в auth-store не мешает показать каталог.
 */
export async function fetchStatic(url: string, options: FetchOptions = {}): Promise<StaticResult> {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  let response: Response
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // Сетевая ошибка и таймаут неотличимы для вызывающего: и то и другое — «источник не ответил».
    return { ok: false, reason: "unreachable" }
  }

  if (!response.ok) return { ok: false, reason: "http_status", status: response.status }

  const text = await response.text().catch(() => "")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid_envelope" }
  }

  const catalog = CorpSchema.parseCatalog(parsed)
  if (!catalog) return { ok: false, reason: "invalid_envelope" }
  return { ok: true, version: catalog.version, servers: catalog.servers, dropped: catalog.dropped }
}

/**
 * Текст диагностики отказа источника (S-C10 п.5, S-V14 п.7): молчаливая деградация запрещена так
 * же, как молчаливо пустой экран. Наружу пользователю это не показывается — он видит только то,
 * что каталог пришёл из другого источника.
 */
export function failureReason(failure: StaticFailure): string {
  switch (failure.reason) {
    case "http_status":
      return `http ${failure.status}`
    case "invalid_envelope":
      return "envelope"
    default:
      return "unreachable"
  }
}
