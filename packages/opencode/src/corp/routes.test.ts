import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import * as CorpSchema from "./schema"
import { CorpDisabledError, CorpHubError, CorpPaths } from "@/server/routes/instance/httpapi/groups/corp"

/**
 * Поверхность корп-роутов и схемы их ответов (S-A1, S-A5, S-V1; AC-09, AC-14, AC-15, AC-38, AC-48).
 *
 * Проверяется контракт наружу: набор маршрутов, форма ответов и то, что секреты в схемы не входят.
 */

const decode = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownOption(schema)(value)

describe("корп-роуты — набор маршрутов (AC-14, AC-38)", () => {
  test("AC-14: маршруты входа объявлены путями из спецификации", () => {
    expect(CorpPaths.loginStart).toBe("/corp/login/start")
    expect(CorpPaths.loginPoll).toBe("/corp/login/poll/:loginID")
    expect(CorpPaths.loginTeam).toBe("/corp/login/poll/:loginID/team")
    expect(CorpPaths.status).toBe("/corp/status")
  })

  test("AC-38: маршруты витрины объявлены путями из спецификации", () => {
    expect(CorpPaths.catalog).toBe("/corp/catalog")
    expect(CorpPaths.connect).toBe("/corp/connectors/:alias/connect")
    expect(CorpPaths.disconnect).toBe("/corp/connectors/:alias/disconnect")
    expect(CorpPaths.permissions).toBe("/corp/connectors/:alias/permissions")
  })

  test("AC-175: «Убрать из списка» — отдельный маршрут DELETE /corp/connectors/:alias", () => {
    // Ревизия 1.9 (S-V17): действие удаляет саму запись коннектора, а не подчинённый ресурс,
    // и потому не совпадает ни с «Отключить», ни с «Правами».
    expect(CorpPaths.forget).toBe("/corp/connectors/:alias")
    expect(CorpPaths.forget).not.toBe(CorpPaths.disconnect)
  })
})

describe("корп-роуты — ошибки (AC-09, AC-22)", () => {
  test("AC-09: выключенный корп-режим отвечает 501 corp_disabled", () => {
    expect(new CorpDisabledError({ error: "corp_disabled" }).error).toBe("corp_disabled")
    expect((CorpDisabledError as any).ast.annotations.httpApiStatus).toBe(501)
  })

  test("AC-22: ошибка Hub отдаётся кодом и необязательным retry_after со статусом 502", () => {
    const error = new CorpHubError({ error: "rate_limited", retry_after: 30 })
    expect(error.error).toBe("rate_limited")
    expect(error.retry_after).toBe(30)
    expect((CorpHubError as any).ast.annotations.httpApiStatus).toBe(502)
  })
})

describe("корп-роуты — схемы ответов (AC-14, AC-15)", () => {
  test("AC-15: ответ POST /corp/login/start не содержит poll_secret", () => {
    expect(Object.keys(CorpSchema.LoginStart.fields)).toEqual(["login_id", "user_code", "browser_url", "expires_in"])
    expect(Object.keys(CorpSchema.LoginStart.fields)).not.toContain("poll_secret")

    const decoded = decode(CorpSchema.LoginStart, {
      login_id: "login-1",
      user_code: "MGNT-4271",
      browser_url: "https://hub.test/ui/login/login-1",
      expires_in: 600,
      poll_secret: "secret-do-not-leak",
    })
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) throw new Error("ожидался разбор")
    expect(JSON.stringify(decoded.value)).not.toContain("secret-do-not-leak")
  })

  test("AC-14: ответ опроса имеет четыре ветви — pending, выбор команды, ready и ошибка", () => {
    expect(Option.isSome(decode(CorpSchema.LoginPoll, { status: "pending" }))).toBe(true)
    expect(
      Option.isSome(
        decode(CorpSchema.LoginPoll, {
          status: "team_selection_required",
          teams: [{ team_id: "t1", team_alias: "A" }],
        }),
      ),
    ).toBe(true)
    expect(
      Option.isSome(
        decode(CorpSchema.LoginPoll, {
          status: "ready",
          user: { user_id: "u1", email: "u@m.ru" },
          key_kind: "persistent",
        }),
      ),
    ).toBe(true)
    expect(
      Option.isSome(decode(CorpSchema.LoginPoll, { status: "error", error: "login_expired", message: "истекла" })),
    ).toBe(true)
  })

  test("AC-15: ответ ready не содержит ключа провайдера", () => {
    const decoded = decode(CorpSchema.LoginPoll, {
      status: "ready",
      user: { user_id: "u1", email: "u@m.ru" },
      key_kind: "persistent",
      key: "sk-test",
    })
    if (Option.isNone(decoded)) throw new Error("ожидался разбор")
    expect(JSON.stringify(decoded.value)).not.toContain("sk-test")
  })

  test("AC-14: GET /corp/status описывает адрес, признаки и кэш каталога", () => {
    const decoded = decode(CorpSchema.CorpStatus, {
      hub_url: "https://hub.test",
      enabled: true,
      authenticated: true,
      user: { user_id: "u1", email: "u@m.ru" },
      key_kind: "persistent",
      catalog_version: "2026-08-19.1",
      catalog_cached_at: 1_700_000_000_000,
      catalog_stale: false,
    })
    expect(Option.isSome(decoded)).toBe(true)
    // Ванильный режим: обязательны только флаги.
    expect(Option.isSome(decode(CorpSchema.CorpStatus, { enabled: false, authenticated: false }))).toBe(true)
  })

  test("AC-38: витрина отдаёт источник, признак протухания и карточки", () => {
    const view = {
      version: "2026-08-19.1",
      source: "cache",
      cached_at: 1_700_000_000_000,
      stale: true,
      servers: [
        {
          alias: "gitlab",
          title: "GitLab",
          status: "not_connected",
          actions: ["connect", "open_hub"],
          // Ревизия 1.9 (S-V15, S-V16): состояние карточки и признак «подключение состоялось»
          // отдаются наружу как обязательные поля — оболочка их не домысливает (S-T10).
          state: "never",
          ever_connected: false,
          deprecated: false,
          blocked: true,
          configured: false,
        },
      ],
      hub_error: "hub_unavailable",
    }
    expect(Option.isSome(decode(CorpSchema.CatalogView, view))).toBe(true)
  })

  test("AC-38: карточка без state или без ever_connected схемой не принимается", () => {
    // Обязательность этих полей и есть то, что не даёт оболочке завести вторую копию правила
    // S-V16 и домыслить состояние по `actions` и `status` (S-T10).
    const card = {
      alias: "gitlab",
      title: "GitLab",
      status: "not_connected",
      actions: ["connect", "open_hub"],
      state: "never",
      ever_connected: false,
      deprecated: false,
      blocked: false,
      configured: false,
    }
    const view = (server: Record<string, unknown>) => ({
      version: "1",
      source: "hub",
      stale: false,
      servers: [server],
    })
    expect(Option.isSome(decode(CorpSchema.CatalogView, view(card)))).toBe(true)

    for (const missing of ["state", "ever_connected"]) {
      const broken: Record<string, unknown> = { ...card }
      delete broken[missing]
      expect(Option.isNone(decode(CorpSchema.CatalogView, view(broken))), missing).toBe(true)
    }

    // Состояние — одно из пяти значений таблицы S-V16, чужое значение не принимается.
    expect(Option.isNone(decode(CorpSchema.CatalogView, view({ ...card, state: "почти_подключён" })))).toBe(true)
  })

  test("AC-38: набор действий карточки пополнен значением forget, прежние сохранены (S-V16)", () => {
    for (const action of ["connect", "reconnect", "disconnect", "forget", "permissions", "open_hub"]) {
      const decoded = decode(CorpSchema.CatalogView, {
        version: "1",
        source: "hub",
        stale: false,
        servers: [
          {
            alias: "gitlab",
            title: "GitLab",
            status: "not_connected",
            actions: [action],
            state: "never",
            ever_connected: false,
            deprecated: false,
            blocked: false,
            configured: false,
          },
        ],
      })
      expect(Option.isSome(decoded), action).toBe(true)
    }
  })

  test("AC-180: ответ connect несёт класс ошибки подключения (S-V19)", () => {
    for (const errorClass of ["token_rejected", "method_unavailable", "hub_unreachable", "unknown"]) {
      const decoded = decode(CorpSchema.ConnectorResult, {
        alias: "gitlab",
        status: "needs_auth",
        error: "denied",
        error_class: errorClass,
      })
      expect(Option.isSome(decoded), errorClass).toBe(true)
    }
    // Чужой класс схемой не принимается: их ровно четыре (S-V19).
    expect(
      Option.isNone(
        decode(CorpSchema.ConnectorResult, { alias: "gitlab", status: "needs_auth", error_class: "просто_ошибка" }),
      ),
    ).toBe(true)
  })

  test("AC-175, AC-176: ответ «Убрать из списка» описан схемой с removed и необязательным hub_error", () => {
    const ok = decode(CorpSchema.ForgetResult, { alias: "gitlab", status: "not_connected", removed: true })
    expect(Option.isSome(ok)).toBe(true)

    const hubDown = decode(CorpSchema.ForgetResult, {
      alias: "gitlab",
      status: "not_connected",
      removed: true,
      hub_error: "hub_unavailable",
    })
    if (Option.isNone(hubDown)) throw new Error("ожидался разбор")
    // Локальные шаги выполнены и не откачены — это и означает removed:true рядом с hub_error.
    expect(hubDown.value.removed).toBe(true)
    expect(hubDown.value.hub_error).toBe("hub_unavailable")
  })

  test("AC-48: состояние «Требуется вход» выражается hub_error=unauthorized и пустым списком", () => {
    const decoded = decode(CorpSchema.CatalogView, {
      version: "",
      source: "cache",
      stale: true,
      servers: [],
      hub_error: "unauthorized",
    })
    expect(Option.isSome(decoded)).toBe(true)
    if (Option.isNone(decoded)) throw new Error("ожидался разбор")
    expect(decoded.value.servers).toEqual([])
    expect(decoded.value.hub_error).toBe("unauthorized")
  })

  test("AC-70: «Каталог пуст» отличим от «Hub недоступен» и «Требуется вход»", () => {
    const empty = decode(CorpSchema.CatalogView, {
      version: "2026-08-19.1",
      source: "hub",
      cached_at: 1_700_000_000_000,
      stale: false,
      servers: [],
    })
    if (Option.isNone(empty)) throw new Error("ожидался разбор")
    // Каталог пуст: Hub ответил, ошибки нет.
    expect(empty.value.source).toBe("hub")
    expect(empty.value.stale).toBe(false)
    expect(empty.value.hub_error).toBeUndefined()

    const down = decode(CorpSchema.CatalogView, {
      version: "",
      source: "cache",
      stale: true,
      servers: [],
      hub_error: "hub_unavailable",
    })
    if (Option.isNone(down)) throw new Error("ожидался разбор")
    expect(down.value.hub_error).toBe("hub_unavailable")
    expect(down.value.source).toBe("cache")
  })

  test("AC-38: результаты действий витрины описаны схемами", () => {
    expect(Option.isSome(decode(CorpSchema.ConnectorResult, { alias: "gitlab", status: "connected" }))).toBe(true)
    expect(
      Option.isSome(decode(CorpSchema.ConnectorResult, { alias: "gitlab", status: "needs_auth", error: "denied" })),
    ).toBe(true)
    expect(
      Option.isSome(
        decode(CorpSchema.PermissionsResult, {
          alias: "gitlab",
          status: "connected",
          preset: "readwrite",
          reauth_required: true,
        }),
      ),
    ).toBe(true)
  })

  test("AC-40: карточка каталога без alias схемой не принимается", () => {
    expect(
      Option.isNone(
        decode(CorpSchema.Catalog, {
          version: "1",
          servers: [{ title: "GitLab", status: "ga", mode: "facade", mcp_url: "https://hub.test/mcp/gitlab" }],
        }),
      ),
    ).toBe(true)
  })

  test("AC-14: неизвестный статус подключения схемой не принимается", () => {
    expect(
      Option.isNone(
        decode(CorpSchema.Catalog, {
          version: "1",
          servers: [
            {
              alias: "gitlab",
              title: "GitLab",
              status: "ga",
              mode: "facade",
              mcp_url: "https://hub.test/mcp/gitlab",
              connection: { status: "почти_подключён" },
            },
          ],
        }),
      ),
    ).toBe(true)
  })
})
