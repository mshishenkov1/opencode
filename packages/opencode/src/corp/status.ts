import type * as CorpSchema from "./schema"

/**
 * Вычисление статуса карточки витрины (S-V6, S-Q9).
 *
 * Чистый модуль без ввода-вывода: общий для корп-роутов, TUI и Desktop/web, чтобы правило было
 * ровно одно и проверялось модульным тестом.
 */

/** Локальный статус MCP-сервера (F14). */
export type LocalStatus = "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"

export interface Input {
  alias: string
  /** Карточка каталога Hub; `undefined` — alias в каталоге отсутствует (скрыт/`unconfigured`). */
  server?: CorpSchema.CatalogServer
  /** Есть ли запись `mcp.<alias>` в действующем конфиге. */
  configured: boolean
  /** Локальный статус MCP из `GET /mcp`; `undefined` — сервер локально неизвестен. */
  local?: LocalStatus
  /** Текст ошибки локального статуса `failed` / `needs_client_registration`. */
  localError?: string
  /** Каталог отдан из протухшего кэша (S-V3). */
  stale: boolean
}

export interface Card {
  alias: string
  status: CorpSchema.CardStatus
  actions: CorpSchema.CardAction[]
  /** Бейдж «устаревший» — независимо от статуса (S-V6). */
  deprecated: boolean
  /** Действия «Подключить»/«Права» заблокированы, потому что каталог протух (S-V6, правило 2). */
  blocked: boolean
  /** Подпись карточки: текст ошибки локального статуса. */
  error?: string
}

const NEEDS_AUTH_LOCAL: ReadonlySet<string> = new Set(["needs_auth", "needs_client_registration"])

export function compute(input: Input): Card {
  const deprecated = input.server?.status === "deprecated"
  const connection = input.server?.connection?.status

  // Правило 1: alias отсутствует в каталоге, но есть в конфиге.
  if (!input.server && input.configured) {
    return { alias: input.alias, status: "unavailable", actions: ["disconnect", "open_hub"], deprecated, blocked: false }
  }

  // Правило 2 применяется поверх результата правил 3–7: блокируем действия, но статус считаем как обычно.
  const blocked = input.stale

  let status: CorpSchema.CardStatus
  let actions: CorpSchema.CardAction[]
  let error: string | undefined

  if (input.local === "failed") {
    // Правило 3 (D-11): `failed` ближе к «недоступен», чем к «требуется авторизация».
    status = "unavailable"
    actions = ["reconnect", "disconnect"]
    error = input.localError
  } else if ((input.local && NEEDS_AUTH_LOCAL.has(input.local)) || connection === "needs_reauth") {
    // Правило 4.
    status = "needs_auth"
    actions = ["connect", "disconnect"]
    error = input.local === "needs_client_registration" ? input.localError : undefined
  } else if (input.local === "connected") {
    // Правило 5.
    status = "connected"
    actions = ["permissions", "disconnect", "open_hub"]
  } else {
    // Правила 6 и 7 дают одинаковый результат; различие только в происхождении записи.
    status = "not_connected"
    actions = ["connect", "open_hub"]
  }

  // Карточка `deprecated`: «Подключить» доступно только как переподключение уже настроенного alias.
  if (deprecated && !input.configured) actions = actions.filter((action) => action !== "connect")

  if (blocked) actions = actions.filter((action) => action !== "connect" && action !== "permissions")

  return error === undefined
    ? { alias: input.alias, status, actions, deprecated, blocked }
    : { alias: input.alias, status, actions, deprecated, blocked, error }
}

/** Поиск по подстроке без учёта регистра по `title`, `alias`, `description`, `owner` (S-V11). */
export function matches(server: CorpSchema.CatalogServer, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [server.title, server.alias, server.description, server.owner].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(needle),
  )
}

/**
 * Группировка по владельцу с сохранением порядка каталога Hub (S-V11, I-1 R-A3).
 * Порядок групп определяется первым вхождением владельца, порядок карточек внутри группы — исходный.
 */
export function groupByOwner<T extends { owner?: string }>(servers: T[]): { owner: string; servers: T[] }[] {
  const groups: { owner: string; servers: T[] }[] = []
  const index = new Map<string, number>()
  for (const server of servers) {
    const owner = server.owner ?? ""
    const at = index.get(owner)
    if (at === undefined) {
      index.set(owner, groups.length)
      groups.push({ owner, servers: [server] })
      continue
    }
    groups[at].servers.push(server)
  }
  return groups
}

/** Пресет по умолчанию (D-6, I-3 R-49). */
export const DEFAULT_PRESET = "readonly"

/**
 * Значение `mcp.<alias>.oauth.scope` (D-5): только для `mode: "facade"`.
 * Для `mode: "native"` права выбираются экраном согласия самого сервера.
 */
export function oauthScope(server: Pick<CorpSchema.CatalogServer, "alias" | "mode">, preset: string) {
  return server.mode === "facade" ? `${server.alias}:${preset}` : undefined
}
