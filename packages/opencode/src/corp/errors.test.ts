import { describe, expect, test } from "bun:test"
import * as CorpErrors from "./errors"

/**
 * Стабильные коды ошибок корп-роутов (S-A5; AC-21, AC-22, AC-23, AC-99).
 *
 * Наружу уходит только код (+ `Retry-After`): тексты Hub могут содержать секреты и не пересылаются.
 */

/** Коды, перечисленные в S-A5. */
const SPEC_CODES = [
  "corp_disabled",
  "hub_unavailable",
  "login_expired",
  "forbidden",
  "invalid_team",
  "team_selection_not_required",
  "rate_limited",
  "litellm_unavailable",
  "litellm_invalid_response",
  "unauthorized",
] as const

describe("corp/errors (AC-21, AC-22, AC-23, AC-99)", () => {
  test("AC-99: все коды S-A5 объявлены модулем", () => {
    for (const code of SPEC_CODES) expect(CorpErrors.CODES).toContain(code)
  })

  test("AC-23: известный код в теле ответа имеет приоритет над статусом", () => {
    expect(CorpErrors.fromResponse(502, { error: "litellm_invalid_response" })).toBe("litellm_invalid_response")
    expect(CorpErrors.fromResponse(502, { error: "litellm_unavailable" })).toBe("litellm_unavailable")
    expect(CorpErrors.fromResponse(404, { error: "login_expired" })).toBe("login_expired")
  })

  test("AC-22: неизвестный код в теле игнорируется, работает отображение по статусу", () => {
    expect(CorpErrors.fromResponse(429, { error: "too_many" })).toBe("rate_limited")
    expect(CorpErrors.fromResponse(400, {})).toBe("invalid_request")
    expect(CorpErrors.fromResponse(401, undefined)).toBe("unauthorized")
    expect(CorpErrors.fromResponse(403, undefined)).toBe("forbidden")
    expect(CorpErrors.fromResponse(404, undefined)).toBe("not_found")
    expect(CorpErrors.fromResponse(409, undefined)).toBe("team_selection_not_required")
  })

  test("AC-21: overrides уточняют статус для конкретного маршрута", () => {
    expect(CorpErrors.fromResponse(404, undefined, { 404: "login_expired" })).toBe("login_expired")
    expect(CorpErrors.fromResponse(400, undefined, { 400: "invalid_team" })).toBe("invalid_team")
  })

  test("AC-20: любой 5xx без известного кода — hub_unavailable", () => {
    expect(CorpErrors.fromResponse(500, undefined)).toBe("hub_unavailable")
    expect(CorpErrors.fromResponse(502, undefined)).toBe("hub_unavailable")
    expect(CorpErrors.fromResponse(503, { error: "maintenance" })).toBe("hub_unavailable")
  })

  test("AC-22: Retry-After разбирается в секунды, мусор игнорируется", () => {
    expect(CorpErrors.retryAfterSeconds(new Headers({ "retry-after": "30" }))).toBe(30)
    expect(CorpErrors.retryAfterSeconds(new Headers({ "retry-after": "0" }))).toBe(0)
    expect(
      CorpErrors.retryAfterSeconds(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })),
    ).toBeUndefined()
    expect(CorpErrors.retryAfterSeconds(new Headers({ "retry-after": "-5" }))).toBeUndefined()
    expect(CorpErrors.retryAfterSeconds(new Headers())).toBeUndefined()
  })
})
