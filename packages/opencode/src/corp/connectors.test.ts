import { describe, expect, test } from "bun:test"
import * as CorpConnectors from "./connectors"
import type * as CorpSchema from "./schema"

/**
 * Действия витрины над конфигом (S-V7…S-V10, S-Q4; AC-57, AC-58, AC-61, AC-62, AC-64, AC-65, AC-68).
 *
 * Проверяются патчи, которые уходят в `Config.updateGlobal`, и признак повторной авторизации.
 */

const facade: CorpSchema.CatalogServer = {
  alias: "gitlab",
  title: "GitLab",
  status: "ga",
  mode: "facade",
  mcp_url: "https://hub.test/mcp/gitlab",
  permission_model: { kind: "header_groups", groups: [{ id: "read", title: "Чтение", preset: "readonly" }] },
}

const native: CorpSchema.CatalogServer = {
  alias: "tag",
  title: "ТЭГ",
  status: "beta",
  mode: "native",
  mcp_url: "https://hub.test/mcp/tag",
  permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
}

describe("corp/connectors — «Подключить» (AC-57, AC-58, AC-61)", () => {
  test("AC-57: facade-сервер получает запись mcp.<alias> с oauth.scope", () => {
    expect(CorpConnectors.connectPatch(facade, "readonly")).toEqual({
      mcp: {
        gitlab: {
          type: "remote",
          url: "https://hub.test/mcp/gitlab",
          enabled: true,
          oauth: { scope: "gitlab:readonly" },
        },
      },
    })
  })

  test("AC-58: native-сервер не получает ключ oauth", () => {
    const patch = CorpConnectors.connectPatch(native, "readonly")
    expect(patch).toEqual({
      mcp: { tag: { type: "remote", url: "https://hub.test/mcp/tag", enabled: true } },
    })
    expect("oauth" in patch.mcp["tag"]!).toBe(false)
  })

  test("AC-61: без явного пресета используется readonly", () => {
    const patch = CorpConnectors.connectPatch(facade)
    expect(patch.mcp["gitlab"]!.oauth).toEqual({ scope: "gitlab:readonly" })
  })

  test("AC-57: расширенный пресет попадает в scope", () => {
    const patch = CorpConnectors.connectPatch(facade, "readwrite")
    expect(patch.mcp["gitlab"]!.oauth).toEqual({ scope: "gitlab:readwrite" })
  })
})

describe("corp/connectors — «Отключить» (AC-62)", () => {
  test("AC-62: патч гасит запись, но не удаляет её", () => {
    const patch = CorpConnectors.disconnectPatch("gitlab") as { mcp: Record<string, unknown> }
    expect(patch).toEqual({ mcp: { gitlab: { enabled: false } } })
    expect(patch.mcp["gitlab"]).not.toBeUndefined()
  })
})

describe("corp/connectors — «Права» (AC-64, AC-65)", () => {
  test("AC-64: facade — патч обновляет только oauth.scope", () => {
    expect(CorpConnectors.permissionsPatch(facade, "readwrite") as unknown).toEqual({
      mcp: { gitlab: { oauth: { scope: "gitlab:readwrite" } } },
    } as unknown)
  })

  test("AC-65: native — локального патча нет", () => {
    expect(CorpConnectors.permissionsPatch(native, "readwrite")).toBeUndefined()
  })

  test("AC-64: смена пресета требует повторной авторизации", () => {
    expect(CorpConnectors.needsReauth("readonly", "readwrite", "connected")).toBe(true)
  })

  test("AC-64: статус needs_reauth от Hub требует повторной авторизации даже при том же пресете", () => {
    expect(CorpConnectors.needsReauth("readwrite", "readwrite", "needs_reauth")).toBe(true)
  })

  test("AC-64: тот же пресет и connected — повторная авторизация не нужна", () => {
    expect(CorpConnectors.needsReauth("readonly", "readonly", "connected")).toBe(false)
  })

  test("AC-64: неизвестный прежний пресет не считается сменой", () => {
    expect(CorpConnectors.needsReauth(undefined, "readwrite", "connected")).toBe(false)
  })
})

describe("corp/connectors — «Открыть в Hub» (AC-68)", () => {
  test("AC-68: ссылка ведёт на карточку сервера в Hub", () => {
    expect(CorpConnectors.hubServerUrl("https://hub.test", "gitlab")).toBe("https://hub.test/ui/servers/gitlab")
    expect(CorpConnectors.hubServerUrl("https://hub.test/", "gitlab-platform")).toBe(
      "https://hub.test/ui/servers/gitlab-platform",
    )
  })

  test("AC-68: без адреса Hub действие недоступно", () => {
    expect(CorpConnectors.hubServerUrl(undefined, "gitlab")).toBeUndefined()
    expect(CorpConnectors.hubServerUrl("", "gitlab")).toBeUndefined()
  })
})
