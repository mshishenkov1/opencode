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

/**
 * Классы ошибок подключения (S-V19, D-32; AC-180…AC-183).
 *
 * Класс отвечает не на вопрос «как ошибка называется внутри» (на него отвечает `Code`), а на два
 * вопроса пользователя: что пошло не так и что теперь делать. Класс определяется **всегда**:
 * «ошибка без объяснения» — дефект, а не допустимое состояние.
 */
describe("corp/errors — классы ошибок подключения (S-V19; AC-180…AC-183)", () => {
  test("AC-180: отказ авторизации во всех трёх видах даёт token_rejected", () => {
    // (1) ошибка OAuth, (2) 401 от MCP-прокси Hub, (3) JSON-RPC error.data.reason = needs_reauth.
    expect(CorpErrors.connectErrorClass({ message: "OAuth error: invalid_grant" })).toBe("token_rejected")
    expect(CorpErrors.connectErrorClass({ message: "authorization failed: HTTP 401 Unauthorized" })).toBe(
      "token_rejected",
    )
    expect(CorpErrors.connectErrorClass({ message: 'jsonrpc error: {"reason":"needs_reauth"}' })).toBe("token_rejected")
    // Тот же класс приходит и от стабильных кодов корп-роутов (S-A5).
    expect(CorpErrors.connectErrorClass({ code: "unauthorized" })).toBe("token_rejected")
    expect(CorpErrors.connectErrorClass({ code: "forbidden" })).toBe("token_rejected")
    expect(CorpErrors.connectErrorClass({ message: "access_denied by user" })).toBe("token_rejected")
  })

  test("AC-181: отказ регистрации клиента и needs_client_registration дают method_unavailable", () => {
    expect(CorpErrors.connectErrorClass({ local: "needs_client_registration" })).toBe("method_unavailable")
    expect(CorpErrors.connectErrorClass({ message: "dynamic client registration failed with 400" })).toBe(
      "method_unavailable",
    )
    expect(CorpErrors.connectErrorClass({ message: "DCR is not supported by the server" })).toBe("method_unavailable")
    // Карточки нет в каталоге — значит нет ни `mcp_url`, ни режима: подключать этим способом нечем.
    expect(CorpErrors.connectErrorClass({ code: "not_found" })).toBe("method_unavailable")
    // Отказ регистрации сообщается текстом, в котором встречаются и коды 400/401: узкий признак
    // проверяется раньше широкого, иначе способ подключения выглядел бы отвергнутым токеном.
    expect(CorpErrors.connectErrorClass({ local: "needs_client_registration", message: "401 during registration" })).toBe(
      "method_unavailable",
    )
  })

  test("AC-182: ответа не было вовсе — network_unreachable, а у карточки через Hub — hub_unreachable", () => {
    const viaHub = { mode: "facade", hubConfigured: true }
    for (const message of ["fetch failed: ETIMEDOUT", "network error: ECONNREFUSED", "socket hang up", "ENOTFOUND"]) {
      // Адрес принадлежит целевой системе — назвать молчание Hub нечем: это была бы выдумка.
      expect(CorpErrors.connectErrorClass({ message }), message).toBe("network_unreachable")
      // У `mode:"facade"` за MCP-адресом стоит сам Hub — и только там его честно назвать.
      expect(CorpErrors.connectErrorClass({ message, ...viaHub }), message).toBe("hub_unreachable")
      // Тот же вход в сборке без адреса Hub Hub не называет ни при каком способе (D-43).
      expect(
        CorpErrors.connectErrorClass({ message, mode: "facade", hubConfigured: false }),
        message,
      ).toBe("network_unreachable")
    }
  })

  test("AC-182: система ответила отказом — upstream_unavailable, а у карточки через Hub — hub_unreachable", () => {
    for (const message of ["HTTP 502 Bad Gateway", "503 Service Unavailable", "internal server error"]) {
      expect(CorpErrors.connectErrorClass({ message }), message).toBe("upstream_unavailable")
      expect(CorpErrors.connectErrorClass({ message, mode: "facade", hubConfigured: true }), message).toBe(
        "hub_unreachable",
      )
    }
    // «Gateway timeout» — ОТВЕТ, а не молчание, хотя в тексте есть слово timeout: узкий признак
    // проверяется раньше широкого, иначе отказ шлюза выглядел бы обрывом связи и звал включить VPN.
    expect(CorpErrors.connectErrorClass({ message: "504 gateway time-out" })).toBe("upstream_unavailable")
  })

  test("AC-182: коды S-A5 про недоступный Hub дают hub_unreachable — идентификатор класса не изменён", () => {
    for (const code of ["hub_unavailable", "hub_invalid_response", "rate_limited"] as const)
      expect(CorpErrors.connectErrorClass({ code }), code).toBe("hub_unreachable")
  })

  test("AC-183: неотнесённая ошибка получает unknown, а не отсутствие класса", () => {
    expect(CorpErrors.connectErrorClass({})).toBe("unknown")
    expect(CorpErrors.connectErrorClass({ message: "что-то пошло не так" })).toBe("unknown")
    expect(CorpErrors.connectErrorClass({ message: "" })).toBe("unknown")
    expect(CorpErrors.connectErrorClass({ code: "invalid_request" })).toBe("unknown")
  })

  test("AC-183: класс определяется при любом входе — состояния «ошибка без объяснения» нет", () => {
    const inputs: { code?: CorpErrors.Code; local?: string; message?: string }[] = [
      {},
      { message: "boom" },
      { local: "failed" },
      { local: "needs_auth" },
      ...CorpErrors.CODES.map((code) => ({ code })),
    ]
    for (const input of inputs) {
      const result = CorpErrors.connectErrorClass(input)
      expect(CorpErrors.ERROR_CLASSES, JSON.stringify(input)).toContain(result)
    }
  })

  test("AC-180: класс — одно из шести слов, тело ответа Hub и секреты в него не попадают", () => {
    // Ревизия 1.14 расщепила прежний общий `hub_unreachable` на три: имена прежних классов не
    // менялись, добавились два новых. Список сверяется дословно и в порядке объявления: молчаливое
    // появление седьмого класса без текста в словаре — тот самый дефект «ошибка без объяснения».
    expect([...CorpErrors.ERROR_CLASSES]).toEqual([
      "token_rejected",
      "method_unavailable",
      "network_unreachable",
      "upstream_unavailable",
      "hub_unreachable",
      "unknown",
    ])
    const secret = "poll_secret=secret-do-not-leak; key=sk-magnit"
    const result = CorpErrors.connectErrorClass({ message: `401 unauthorized ${secret}` })
    expect(result).toBe("token_rejected")
    expect(JSON.stringify(result)).not.toContain("secret-do-not-leak")
    expect(JSON.stringify(result)).not.toContain("sk-magnit")
  })
})
