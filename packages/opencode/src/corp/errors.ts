import { Schema } from "effect"

/**
 * Стабильные коды ошибок корп-роутов (S-A5).
 *
 * Наружу уходит только код (+ `retry_after` при наличии), тексты Hub не пересылаются: они могут
 * содержать секреты. Человекочитаемое сообщение подставляет UI из своего словаря (S-I*).
 */
export const CODES = [
  "corp_disabled",
  "hub_unavailable",
  "hub_invalid_response",
  "login_expired",
  "forbidden",
  "invalid_team",
  "team_selection_not_required",
  "rate_limited",
  "litellm_unavailable",
  "litellm_invalid_response",
  "unauthorized",
  "not_found",
  "invalid_request",
] as const

export type Code = (typeof CODES)[number]

export const Code = Schema.Literals(CODES)

/** Ошибка обращения к Hub в форме, пригодной для передачи в UI. */
export interface HubFailure {
  code: Code
  /** Значение заголовка `Retry-After` в секундах, если Hub его прислал (S-A5). */
  retryAfter?: number
}

const BY_STATUS: Record<number, Code> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "team_selection_not_required",
  429: "rate_limited",
}

/**
 * Код ошибки по HTTP-статусу и полю `error` тела ответа Hub.
 * Тело имеет приоритет, если Hub прислал один из известных нам кодов.
 * `overrides` уточняет статусы для конкретного маршрута (например `404 → login_expired` для `/cli/poll`).
 */
export function fromResponse(status: number, body: unknown, overrides?: Partial<Record<number, Code>>): Code {
  const declared =
    typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? ((body as { error: string }).error as Code)
      : undefined
  if (declared && (CODES as readonly string[]).includes(declared)) return declared
  const override = overrides?.[status]
  if (override) return override
  if (status >= 500) return "hub_unavailable"
  return BY_STATUS[status] ?? "hub_unavailable"
}

/**
 * Классы ошибок подключения (S-V19, D-32).
 *
 * Класс отвечает не на вопрос «как ошибка называется внутри» (на него отвечает `Code`), а на два
 * вопроса пользователя: что пошло не так и что теперь делать. Два разных кода могут дать один
 * класс — это нормально. Класс определяется **всегда**: неотнесённая ошибка получает `unknown`,
 * у которого тоже есть и текст, и предлагаемое действие; «ошибка без объяснения» — дефект.
 */
export const ERROR_CLASSES = ["token_rejected", "method_unavailable", "hub_unreachable", "unknown"] as const

export type ErrorClass = (typeof ERROR_CLASSES)[number]

export const ErrorClass = Schema.Literals(ERROR_CLASSES)

/** Коды S-A5, класс которых известен без разбора текста. */
const CLASS_BY_CODE: Partial<Record<Code, ErrorClass>> = {
  unauthorized: "token_rejected",
  forbidden: "token_rejected",
  hub_unavailable: "hub_unreachable",
  hub_invalid_response: "hub_unreachable",
  rate_limited: "hub_unreachable",
  litellm_unavailable: "hub_unreachable",
  litellm_invalid_response: "hub_unreachable",
  // Карточки нет в каталоге — значит нет ни `mcp_url`, ни режима: подключить этим способом нечем.
  not_found: "method_unavailable",
  corp_disabled: "method_unavailable",
}

/**
 * Признаки классов в тексте ошибки MCP-OAuth.
 *
 * Порядок проверки — от более узкого к более широкому: отказ регистрации клиента (DCR) сообщается
 * текстом, в котором встречаются и коды 400/401, поэтому он проверяется первым.
 */
const METHOD_PATTERNS =
  /client[ _-]?registration|\bdcr\b|dynamic client|registration (?:failed|not|is not)|needs_client_registration|not supported|unsupported|no mcp_url|missing mcp_url|method[ _-]?unavailable/
const TOKEN_PATTERNS =
  /invalid_grant|access_denied|invalid_token|invalid_client|needs_reauth|unauthorized|forbidden|\b401\b|\b403\b/
const NETWORK_PATTERNS =
  /timeout|timed ?out|network|fetch failed|econnrefused|econnreset|enotfound|socket hang up|bad gateway|service unavailable|\b5\d\d\b/

/**
 * Класс ошибки подключения (S-V19).
 *
 * Источники различны и дополняют друг друга: `code` — стабильный код корп-роута (S-A5), `local` —
 * локальный статус MCP после неудачной авторизации, `message` — текст ошибки MCP-OAuth. Тела
 * ответов Hub, ключи и `poll_secret` сюда не попадают и наружу не уходят: класс — это одно из
 * четырёх слов, а текст пользователю подставляет словарь (S-I1).
 */
export function connectErrorClass(input: { code?: Code; local?: string; message?: string }): ErrorClass {
  if (input.local === "needs_client_registration") return "method_unavailable"
  if (input.code !== undefined) {
    const byCode = CLASS_BY_CODE[input.code]
    if (byCode) return byCode
  }
  const message = (input.message ?? "").toLowerCase()
  if (message) {
    if (METHOD_PATTERNS.test(message)) return "method_unavailable"
    if (TOKEN_PATTERNS.test(message)) return "token_rejected"
    if (NETWORK_PATTERNS.test(message)) return "hub_unreachable"
  }
  return "unknown"
}

export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
