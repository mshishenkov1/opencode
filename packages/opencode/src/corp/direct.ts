import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as CorpSchema from "./schema"

/**
 * Прямое подключение токеном: проверка, обмен и отзыв (S-V25, S-V27, ревизия 1.13).
 *
 * За всё действие приложение обращается ровно по двум адресам — `verify.url` (и, если объявлен,
 * `exchange.url`) и `upstream.url`. Обращений по адресу Hub здесь нет **при любом** его значении:
 * прямой режим о Hub не знает и знать не должен (S-V25 п.8).
 *
 * Наборы исходов **закрыты** (пять у проверки, четыре у обмена, четыре у отзыва) и в «получилось /
 * не получилось» не схлопываются: различается **то, что известно**, а не совет пользователю
 * (S-V25 п.3, п.5; S-V27 п.2).
 *
 * Модуль на промисах и без Effect: его зовёт корп-роут, а покрывается он моком `fetch`.
 */

/** Таймаут запроса к целевой системе (S-V25 п.2). */
export const REQUEST_TIMEOUT_MS = 10_000

/**
 * Заголовки, которые приложение добавляет **от себя**, и других нет (S-V25 п.2).
 *
 * В частности, ключ `magnit_prod` в проверку не подставляется никогда: целевая система про
 * корпоративный SSO ничего не знает.
 */
export function ownHeaders(): Record<string, string> {
  return { accept: "application/json", "user-agent": `opencode/${InstallationVersion}` }
}

export interface Options {
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Ответ целевой системы: код и тело; `undefined` — ответа не было вовсе (таймаут, сеть, DNS, TLS). */
interface Answer {
  status: number
  text: string
}

async function call(
  input: { url: string; method: string; headers: Record<string, string>; body?: unknown },
  options: Options,
): Promise<Answer | undefined> {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const headers: Record<string, string> = { ...ownHeaders(), ...input.headers }
  if (input.body !== undefined) headers["content-type"] = "application/json"
  let response: Response
  try {
    response = await doFetch(input.url, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // Таймаут, сетевая ошибка, отказ DNS или TLS неотличимы для вызывающего: ответа не было.
    return undefined
  }
  const text = await response.text().catch(() => "")
  return { status: response.status, text }
}

/** Удовлетворяет ли код ответа ожиданию способа: пустой перечень — «любой 2xx» (S-V24 п.2). */
export function statusMatches(status: number, expected: number[]): boolean {
  if (expected.length === 0) return status >= 200 && status < 300
  return expected.includes(status)
}

/** Значение по пути `a.b.c` в теле ответа; не JSON или не строка — `undefined`. */
export function readField(text: string, field: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  let current: unknown = parsed
  for (const part of field.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === "string" && current !== "" ? current : undefined
}

export interface VerifyOutcome {
  result: CorpSchema.VerifyResult
  /** Код ответа, когда он был; при `upstream_unreachable` поля нет — не известно ничего. */
  status?: number
  account?: string
}

/**
 * Проверка токена — **ровно один** запрос (S-V25 п.2, п.3).
 *
 * Исходов пять, и три пары сливать запрещено: `token_rejected` ≠ `verify_failed` («система сказала
 * „нет“» и «система ответила не то»), `verify_failed` ≠ `upstream_unreachable` («ответ был» и
 * «ответа не было»), `account_missing` ≠ `verified` (успешный код без названного пользователя
 * подтверждением не является).
 */
export async function verify(
  method: CorpSchema.ParsedAuthMethod,
  token: string,
  options: Options = {},
): Promise<VerifyOutcome> {
  const spec = method.verify!
  const answer = await call(
    {
      url: spec.url,
      method: spec.method,
      headers: CorpSchema.substituteHeaders(spec.headers, { access_token: token }),
    },
    options,
  )
  if (!answer) return { result: "upstream_unreachable" }
  if (!statusMatches(answer.status, spec.expect_status)) {
    // `401`/`403` — «система сказала „нет“»; прочие коды — «система ответила не то».
    const rejected = answer.status === 401 || answer.status === 403
    return { result: rejected ? "token_rejected" : "verify_failed", status: answer.status }
  }
  // Имя учётной записи читается всегда, когда каталог назвал поле: при `require_account: false` оно
  // не обязательно, но подпись «Подключено как {{account}}» показать всё равно есть чем.
  const account = spec.account_field === undefined ? undefined : readField(answer.text, spec.account_field)
  // Тело, не разобранное как JSON, при успешном коде даёт тот же исход, что пустое поле: система
  // приняла запрос, но пользователя не назвала (S-V25 п.3).
  if (spec.require_account && account === undefined) return { result: "account_missing", status: answer.status }
  return { result: "verified", status: answer.status, ...(account === undefined ? {} : { account }) }
}

export interface ExchangeOutcome {
  result: CorpSchema.ExchangeResult
  token?: string
  token_id?: string
}

/**
 * Обмен введённого токена на выпущенный — **не более одного** запроса (S-V25 п.5).
 *
 * Ни один из трёх неуспешных исходов **не является ошибкой подключения**: оно продолжается на
 * введённом токене, а пользователю показывается предупреждение. Различимы они по тому, что
 * известно: «не дали права», «ответ был, толку нет», «ответа не было».
 */
export async function exchange(
  method: CorpSchema.ParsedAuthMethod,
  token: string,
  options: Options = {},
): Promise<ExchangeOutcome> {
  const spec = method.exchange!
  const values = { access_token: token, token_description: spec.description }
  const answer = await call(
    {
      url: spec.url,
      method: spec.method,
      headers: CorpSchema.substituteHeaders(spec.headers, values),
      ...(spec.body === undefined ? {} : { body: substituteBody(spec.body, values) }),
    },
    options,
  )
  if (!answer) return { result: "exchange_unreachable" }
  if (answer.status === 401 || answer.status === 403) return { result: "exchange_denied" }
  if (answer.status !== spec.expect_status) return { result: "exchange_failed" }
  const issued = readField(answer.text, spec.token_field)
  // Подошедший код, из тела которого не удалось прочитать непустой `token_field`, — тот же исход
  // «ответ был, толку нет»: выпущенного токена у нас всё равно нет.
  if (issued === undefined) return { result: "exchange_failed" }
  const tokenId = spec.token_id_field === undefined ? undefined : readField(answer.text, spec.token_id_field)
  return { result: "exchanged", token: issued, ...(tokenId === undefined ? {} : { token_id: tokenId }) }
}

export interface RevokeOutcome {
  result: CorpSchema.RevokeResult
  status?: number
}

/**
 * Отзыв выпущенного токена (S-V27 п.2) — **best effort**: его исход на удаление записи хранилища
 * не влияет.
 *
 * `skipped` («звать было некого») и `unreachable` («позвали, не ответил») — разные события, и
 * путать их запрещено дословно так же, как в S-V8 и S-A14 п.6. Чужой токен (`issued: false`)
 * приложение не отзывает, а только забывает: он принадлежит учётной записи пользователя и мог быть
 * выпущен для других задач.
 */
export async function revoke(
  method: CorpSchema.ParsedAuthMethod | undefined,
  record: { token: string; token_id?: string; issued: boolean },
  options: Options = {},
): Promise<RevokeOutcome> {
  const spec = method?.revoke
  if (!spec || !record.issued) return { result: "skipped" }
  const values = { access_token: record.token, token_id: record.token_id ?? "" }
  const answer = await call(
    {
      url: CorpSchema.substitute(spec.url, values),
      method: spec.method,
      headers: CorpSchema.substituteHeaders(spec.headers, values),
      ...(spec.body === undefined ? {} : { body: substituteBody(spec.body, values) }),
    },
    options,
  )
  if (!answer) return { result: "unreachable" }
  if (answer.status >= 200 && answer.status < 300) return { result: "revoked", status: answer.status }
  return { result: "not_revoked", status: answer.status }
}

/** Подстановка в тело запроса: строки шаблонизируются, структура сохраняется (S-V25 п.5). */
export function substituteBody(body: unknown, values: Record<string, string>): unknown {
  if (typeof body === "string") return CorpSchema.substitute(body, values)
  if (Array.isArray(body)) return body.map((entry) => substituteBody(entry, values))
  if (typeof body === "object" && body !== null) {
    const result: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(body as Record<string, unknown>))
      result[name] = substituteBody(value, values)
    return result
  }
  return body
}
