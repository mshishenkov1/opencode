import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { CorpCatalogView, CorpStatus } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"

/**
 * Данные и действия корпоративного слоя для Desktop/web (S-D1, S-D6, S-D7).
 *
 * Все обращения к Hub идут через корп-роуты сервера (D-2): браузерный UI в Hub не ходит,
 * CORS там не включён (I-1 R-A7).
 */

/** Клиент создаётся с `throwOnError: true`, поэтому пустое тело — это уже аномалия. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("corp route returned an empty body")
  return value
}

export function useCorpStatus() {
  const sdk = useSDK()
  return useQuery(() => ({
    queryKey: [sdk().scope, sdk().directory, "corp.status"] as const,
    queryFn: (): Promise<CorpStatus> => sdk().client.corp.status().then((response) => required(response.data)),
    // Корп-режим не меняется в течение сессии, но ключ появляется после входа — обновляем по инвалидации.
    staleTime: 30_000,
    retry: false,
  }))
}

export function useCorpCatalog(enabled: () => boolean) {
  const sdk = useSDK()
  return useQuery(() => ({
    queryKey: [sdk().scope, sdk().directory, "corp.catalog"] as const,
    queryFn: (): Promise<CorpCatalogView> => sdk().client.corp.catalog().then((response) => required(response.data)),
    enabled: enabled(),
    retry: false,
  }))
}

/** Инвалидация после действий витрины: каталог, статус и локальные статусы MCP (S-D7). */
export function useCorpInvalidate() {
  const client = useQueryClient()
  const sdk = useSDK()
  return () => {
    const scope = sdk().scope
    const directory = sdk().directory
    return client.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === scope &&
        query.queryKey[1] === directory &&
        (query.queryKey[2] === "corp.catalog" || query.queryKey[2] === "corp.status" || query.queryKey[2] === "mcp"),
    })
  }
}

export type ConnectorAction =
  | { kind: "connect"; alias: string; preset?: string }
  | { kind: "disconnect"; alias: string }
  | { kind: "permissions"; alias: string; preset: string }

export function useConnectorAction() {
  const sdk = useSDK()
  const language = useLanguage()
  const invalidate = useCorpInvalidate()

  return useMutation(() => ({
    mutationFn: async (action: ConnectorAction) => {
      if (action.kind === "connect")
        return sdk()
          .client.corp.connect({ alias: action.alias, ...(action.preset ? { preset: action.preset } : {}) })
          .then((response) => response.data)
      if (action.kind === "disconnect")
        return sdk()
          .client.corp.disconnect({ alias: action.alias })
          .then((response) => response.data)
      return sdk()
        .client.corp.permissions({ alias: action.alias, preset: action.preset })
        .then((response) => response.data)
    },
    onSuccess: async (result) => {
      if (result && "hub_error" in result && result.hub_error) {
        showToast({
          variant: "default",
          title: language.t("corp.hubWarning"),
          description: language.t(corpErrorKey(result.hub_error)),
        })
      }
      if (result && "error" in result && result.error) {
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: result.error })
      }
      if (result && "reauth_required" in result && result.reauth_required) {
        showToast({ variant: "default", title: language.t("corp.connectors.reauth") })
      }
      await invalidate()
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
}

const ERROR_KEYS = [
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

/** Ключ словаря по стабильному коду ошибки корп-роутов (S-A5, S-I1). */
export function corpErrorKey(code: string | undefined) {
  const known = ERROR_KEYS.find((entry) => entry === code)
  return `corp.error.${known ?? "unknown"}` as `corp.error.${(typeof ERROR_KEYS)[number] | "unknown"}`
}
