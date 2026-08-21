import { Option, Schema } from "effect"
import * as CorpErrors from "./errors"
import * as CorpSchema from "./schema"

/**
 * Клиент Hub (S-V2, §3).
 *
 * Тонкая обёртка над `fetch`: базовый URL (S-C5), `Authorization: Bearer <ключ magnit_prod>`,
 * `X-Request-ID` (uuid4) и таймаут 5 с на запрос. Ответы валидируются схемой; несоответствие — ошибка
 * `hub_invalid_response`, ответ отбрасывается целиком (частично карточки не подменяются).
 *
 * Ревизия 1.7 (S-V14): «целиком» относится к **конверту**. Списочные ответы `/api/catalog` и
 * `/api/me/connections` разбираются поэлементно — неразобранный элемент выбрасывается и попадает в
 * `dropped`, остальные принимаются, `hub_invalid_response` остаётся только за нарушением конверта.
 *
 * Модуль намеренно написан на промисах и не зависит от Effect: он вызывается и из корп-роутов, и из CLI,
 * и покрывается модульными тестами с моком `fetch` без поднятия слоёв.
 */

export const REQUEST_TIMEOUT_MS = 5000

export type Result<T> =
  | {
      ok: true
      data: T
      /** Элементы списочного ответа, отброшенные разбором (S-V14 п.5); только для `catalog`/`connections`. */
      dropped?: CorpSchema.Dropped[]
    }
  | ({ ok: false } & CorpErrors.HubFailure)

export interface Options {
  hubUrl: string
  /** Ключ провайдера `magnit_prod` из auth-store; без него доступны только `/cli/*` и `/health`. */
  key?: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Источник `X-Request-ID`; подменяется в тестах. */
  requestId?: () => string
}

interface Call {
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: string
  body?: unknown
  headers?: Record<string, string>
  auth?: boolean
  /** Уточнение кодов ошибок для конкретного маршрута (S-A5). */
  statusOverrides?: Partial<Record<number, CorpErrors.Code>>
}

function fail<T>(code: CorpErrors.Code, retryAfter?: number): Result<T> {
  return retryAfter === undefined ? { ok: false, code } : { ok: false, code, retryAfter }
}

export function make(options: Options) {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const requestId = options.requestId ?? (() => crypto.randomUUID())
  const base = options.hubUrl.replace(/\/+$/, "")

  async function raw(input: Call): Promise<Result<unknown>> {
    if (input.auth !== false && !options.key) return fail("unauthorized")

    const headers: Record<string, string> = {
      accept: "application/json",
      "x-request-id": requestId(),
      ...input.headers,
    }
    if (input.auth !== false && options.key) headers["authorization"] = `Bearer ${options.key}`
    if (input.body !== undefined) headers["content-type"] = "application/json"

    let response: Response
    try {
      response = await doFetch(`${base}${input.path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // Сетевая ошибка и таймаут неотличимы для вызывающего: и то и другое — «Hub недоступен».
      return fail("hub_unavailable")
    }

    const text = await response.text().catch(() => "")
    let parsed: unknown = undefined
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
    }

    if (!response.ok) {
      return fail(
        CorpErrors.fromResponse(response.status, parsed, input.statusOverrides),
        CorpErrors.retryAfterSeconds(response.headers),
      )
    }

    return { ok: true, data: parsed }
  }

  async function call<S extends Schema.Codec<any, any, never, never>>(
    schema: S,
    input: Call,
  ): Promise<Result<S["Type"]>> {
    const result = await raw(input)
    if (!result.ok) return result
    const decoded = Schema.decodeUnknownOption(schema)(result.data)
    if (Option.isNone(decoded)) return fail("hub_invalid_response")
    return { ok: true, data: decoded.value }
  }

  return {
    hubUrl: base,

    /** `GET {hub}/health` — только для `opencode corp status` (S-A11). */
    async health(): Promise<Result<void>> {
      const result = await raw({ method: "GET", path: "/health", auth: false })
      return result.ok ? { ok: true, data: undefined } : result
    },

    /** §3.1 `POST {hub}/cli/start` */
    async cliStart(client: string): Promise<Result<CorpSchema.CliStart>> {
      return call(CorpSchema.CliStart, {
        method: "POST",
        path: "/cli/start",
        body: { client },
        auth: false,
      })
    },

    /** §3.1 `GET {hub}/cli/poll/{login_id}` — `poll_secret` уходит только в заголовке (S-A2). */
    async cliPoll(loginId: string, pollSecret: string): Promise<Result<CorpSchema.CliPoll>> {
      return call(CorpSchema.CliPoll, {
        method: "GET",
        path: `/cli/poll/${encodeURIComponent(loginId)}`,
        headers: { "x-hub-poll-secret": pollSecret },
        auth: false,
        statusOverrides: { 404: "login_expired" },
      })
    },

    /** §3.1 `POST {hub}/cli/poll/{login_id}/team` */
    async cliTeam(loginId: string, pollSecret: string, teamId: string): Promise<Result<CorpSchema.CliPoll>> {
      return call(CorpSchema.CliPoll, {
        method: "POST",
        path: `/cli/poll/${encodeURIComponent(loginId)}/team`,
        headers: { "x-hub-poll-secret": pollSecret },
        body: { team_id: teamId },
        auth: false,
        statusOverrides: { 400: "invalid_team", 404: "login_expired", 409: "team_selection_not_required" },
      })
    },

    /** §3.2 `GET {hub}/api/me` */
    async me(): Promise<Result<CorpSchema.Me>> {
      return call(CorpSchema.Me, { method: "GET", path: "/api/me" })
    },

    /**
     * §3.2 `GET {hub}/api/catalog` — разбор поэлементный (S-V14).
     *
     * `hub_invalid_response` возвращается только при нарушении конверта; карточка, ядро которой не
     * разобрано, отбрасывается поодиночке и попадает в `dropped`, остальные принимаются.
     */
    async catalog(): Promise<Result<CorpSchema.Catalog>> {
      const result = await raw({ method: "GET", path: "/api/catalog" })
      if (!result.ok) return result
      const parsed = CorpSchema.parseCatalog(result.data)
      if (!parsed) return fail("hub_invalid_response")
      return { ok: true, data: { version: parsed.version, servers: parsed.servers }, dropped: parsed.dropped }
    },

    /** §3.2 `GET {hub}/api/me/connections` — поэлементно, как каталог (S-V14 п.6). */
    async connections(): Promise<Result<CorpSchema.MyConnection[]>> {
      const result = await raw({ method: "GET", path: "/api/me/connections" })
      if (!result.ok) return result
      const parsed = CorpSchema.parseMyConnections(result.data)
      if (!parsed) return fail("hub_invalid_response")
      return { ok: true, data: parsed.items, dropped: parsed.dropped }
    },

    /** §3.2 `PUT {hub}/api/me/connections/{alias}/permissions` */
    async setPermissions(
      alias: string,
      preset: string,
      groups?: string[],
    ): Promise<Result<CorpSchema.PermissionsUpdate>> {
      return call(CorpSchema.PermissionsUpdate, {
        method: "PUT",
        path: `/api/me/connections/${encodeURIComponent(alias)}/permissions`,
        body: groups === undefined ? { preset } : { preset, groups },
        statusOverrides: { 404: "not_found" },
      })
    },

    /** §3.2 `DELETE {hub}/api/me/connections/{alias}` */
    async removeConnection(alias: string): Promise<Result<{ alias: string; status: CorpSchema.ConnectionStatus }>> {
      return call(CorpSchema.DisconnectResult, {
        method: "DELETE",
        path: `/api/me/connections/${encodeURIComponent(alias)}`,
        statusOverrides: { 404: "not_found" },
      })
    },
  }
}

export type Client = ReturnType<typeof make>

/** Значение заголовка `client` для `POST /cli/start` (§3.1). */
export function clientDescriptor(version: string) {
  return `opencode/${version} ${process.platform}-${process.arch}`
}
