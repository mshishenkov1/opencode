import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { CorpCatalogView, CorpPermissionMode, CorpStatus } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

/**
 * Данные и действия корпоративного слоя для Desktop/web (S-D1, S-D6, S-D7).
 *
 * Все обращения к Hub идут через корп-роуты сервера (D-2): браузерный UI в Hub не ходит,
 * CORS там не включён (I-1 R-A7).
 *
 * Область — сервер, а не рабочий каталог: корп-роуты объявлены на инстансе и не зависят от
 * `?directory=` (см. `server/routes/instance/httpapi/groups/corp.ts`), а потребители — визуальный
 * `Layout` и его диалоги — живут выше `SDKProvider` (директорного контекста там ещё нет).
 * Поэтому используется `useServerSDK`, доступный во всей оболочке сервера; обращение к `useSDK`
 * из `Layout` роняло приложение («SDK context must be used within a context provider», BUG-I4-002).
 */

/** Клиент создаётся с `throwOnError: true`, поэтому пустое тело — это уже аномалия. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("corp route returned an empty body")
  return value
}

/**
 * Ответ, которым подменяется недоступность корп-роутов (S-C6, BUG-I4-002).
 *
 * Ванильный сервер отвечает на `GET /corp/status` кодом 200 и `enabled=false`, так что сюда
 * попадают только транспортные сбои — недоступный сервер или Hub. Для UI это «корп-функции
 * недоступны», а не исключение: команды и корп-кнопка просто не появляются, поведение остаётся
 * upstream.
 */
const STATUS_UNAVAILABLE: CorpStatus = {
  enabled: false,
  authenticated: false,
  hub_reachable: false,
  hub_error: "hub_unavailable",
}

export function useCorpStatus() {
  const sdk = useServerSDK()
  return useQuery(() => ({
    queryKey: [sdk().scope, "corp.status"] as const,
    queryFn: (): Promise<CorpStatus> =>
      sdk()
        .client.corp.status()
        .then((response) => required(response.data))
        .catch(() => STATUS_UNAVAILABLE),
    // Корп-режим не меняется в течение сессии, но ключ появляется после входа — обновляем по инвалидации.
    staleTime: 30_000,
    retry: false,
    throwOnError: false,
  }))
}

/**
 * Выход из корпоративного SSO (S-A14, S-A16).
 *
 * Ответ описывает **обе** части по отдельности, потому что они по-разному надёжны, и исход каждой
 * показывается, а не подразумевается. Отказ отзыва — **предупреждение, а не ошибка**: локальная
 * часть выполнена, пользователь вышел у себя, и отказать ему в этом нельзя (D-49).
 */
export function useCorpLogout() {
  const sdk = useServerSDK()
  const language = useLanguage()
  const invalidate = useCorpInvalidate()

  return useMutation(() => ({
    mutationFn: () =>
      sdk()
        .client.corp.logout()
        .then((response) => response.data),
    onSuccess: async (result) => {
      if (result) {
        // Идемпотентный случай (S-A14 п.5): ключа не было — «уже вышел» не ошибка.
        if (!result.key_removed && result.hub === "skipped") {
          showToast({ variant: "default", title: language.t("corp.logout.notSignedIn") })
        } else if (result.hub === "unavailable") {
          showToast({
            variant: "default",
            title: language.t("corp.logout.revokeFailed", {
              reason: language.t(corpErrorKey(result.hub_error)),
            }),
          })
        } else {
          // `skipped` при удалённом ключе — сборка без Hub (п.6): о сервере говорить нечего (D-43).
          showToast({
            variant: "success",
            title: language.t(result.hub === "skipped" ? "corp.logout.doneLocal" : "corp.logout.done"),
          })
        }
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

/**
 * Возврат выключенного провайдера (S-C11).
 *
 * Правка касается **ровно одного** элемента `magnit_prod` в `disabled_providers` глобального
 * конфига. Запись в слое, который приложение не правит, не трогается вовсе: ответ называет файл и
 * причину, а молча править не свой слой — та же ошибка, что молча править чужой конфиг (S-C7).
 */
export function useProviderEnable() {
  const sdk = useServerSDK()
  const language = useLanguage()
  const invalidate = useCorpInvalidate()

  return useMutation(() => ({
    mutationFn: () =>
      sdk()
        .client.corp.providerEnable()
        .then((response) => response.data),
    onSuccess: async (result) => {
      if (result && !result.changed && result.reason === "foreign_layer")
        showToast({
          variant: "default",
          title: language.t("corp.provider.enableForeignLayer", { file: result.provider_disabled?.file ?? "" }),
        })
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

export function useCorpCatalog(enabled: () => boolean) {
  const sdk = useServerSDK()
  return useQuery(() => ({
    queryKey: [sdk().scope, "corp.catalog"] as const,
    queryFn: (): Promise<CorpCatalogView> =>
      sdk()
        .client.corp.catalog()
        .then((response) => required(response.data)),
    enabled: enabled(),
    retry: false,
    // Витрина сама показывает «Hub недоступен» по пустым данным — ошибка не должна всплывать
    // в ErrorBoundary приложения (BUG-I4-002).
    throwOnError: false,
  }))
}

/** Инвалидация после действий витрины: каталог, статус и локальные статусы MCP (S-D7). */
export function useCorpInvalidate() {
  const client = useQueryClient()
  const sdk = useServerSDK()
  return () => {
    const scope = sdk().scope
    return client.invalidateQueries({
      predicate: (query) => {
        if (query.queryKey[0] !== scope) return false
        // Корп-ключи — на уровне сервера, ключи MCP — на уровне рабочего каталога
        // (`[scope, directory, "mcp"]`): после действия витрины обновляются все каталоги сервера.
        if (query.queryKey[1] === "corp.catalog" || query.queryKey[1] === "corp.status") return true
        return query.queryKey[2] === "mcp"
      },
    })
  }
}

export type ConnectorAction =
  | { kind: "connect"; alias: string; preset?: string }
  | { kind: "disconnect"; alias: string }
  /** «Убрать из списка» (S-V17): удаляет запись `mcp.<alias>` и снимает признак подключения. */
  | { kind: "forget"; alias: string }
  | { kind: "permissions"; alias: string; preset: string }
  /**
   * Режимы групп разрешений (S-V9 вид `permission_groups`, S-V21). Тот же роут, что у пресетов, —
   * второе, взаимоисключающее с `preset` тело (S-V1): Hub в этой ветке не участвует ни на шаг,
   * запись идёт в раздел `permission` конфига пользователя. В теле идут режимы **всех** групп:
   * запись детерминирована и перезаписывает блок alias целиком, а не правит отдельные ключи.
   */
  | { kind: "permissionModes"; alias: string; modes: Record<string, CorpPermissionMode> }

export function useConnectorAction() {
  const sdk = useServerSDK()
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
      if (action.kind === "forget")
        return sdk()
          .client.corp.forget({ alias: action.alias })
          .then((response) => response.data)
      if (action.kind === "permissionModes")
        return sdk()
          .client.corp.permissions({ alias: action.alias, modes: action.modes })
          .then((response) => response.data)
      return sdk()
        .client.corp.permissions({ alias: action.alias, preset: action.preset })
        .then((response) => response.data)
    },
    onSuccess: async (result) => {
      // S-V17: отказ Hub локальные шаги не откатывает — пользователю показывается предупреждение,
      // называющее ровно то, что произошло: запись удалена у него, а Hub о ней мог не узнать.
      if (result && "removed" in result && result.removed && "hub_error" in result && result.hub_error) {
        showToast({
          variant: "default",
          title: language.t("corp.hubWarning"),
          description: language.t("corp.connectors.forgetHubFailed"),
        })
        await invalidate()
        return
      }
      if (result && "hub_error" in result && result.hub_error) {
        showToast({
          variant: "default",
          title: language.t("corp.hubWarning"),
          description: language.t(corpErrorKey(result.hub_error)),
        })
      }
      if (result && "error" in result && result.error) {
        // S-V19: текст ошибки не показывается голым кодом — рядом идёт объяснение класса.
        const explained =
          "error_class" in result && result.error_class
            ? `${language.t(connectErrorKey(result.error_class), { code: result.error })} (${result.error})`
            : result.error
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: explained })
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

const CONNECT_ERROR_CLASSES = ["token_rejected", "method_unavailable", "hub_unreachable", "unknown"] as const

/**
 * Ключ словаря по классу ошибки подключения (S-V19, S-I1).
 * Неизвестный класс падает в `unknown`: «ошибка без объяснения» — дефект, а не состояние (D-32).
 */
export function connectErrorKey(errorClass: string | undefined) {
  const known = CONNECT_ERROR_CLASSES.find((entry) => entry === errorClass)
  return `corp.error.connect.${known ?? "unknown"}` as `corp.error.connect.${(typeof CONNECT_ERROR_CLASSES)[number]}`
}

/** Ключ словаря по стабильному коду ошибки корп-роутов (S-A5, S-I1). */
export function corpErrorKey(code: string | undefined) {
  const known = ERROR_KEYS.find((entry) => entry === code)
  return `corp.error.${known ?? "unknown"}` as `corp.error.${(typeof ERROR_KEYS)[number] | "unknown"}`
}
