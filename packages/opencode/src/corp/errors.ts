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

export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
