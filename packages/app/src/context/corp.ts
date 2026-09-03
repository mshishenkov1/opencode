import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { CorpCatalogView, CorpConnectTokenResult, CorpPermissionMode, CorpStatus } from "@opencode-ai/sdk/v2"
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
    // Клиент приложения задан с `refetchOnMount: false` (`app.tsx`, `context/global.tsx`), то есть
    // по умолчанию **ни один** экран не перезапрашивает данные при открытии — даже помеченные
    // устаревшими. Корп-статусу это умолчание не подходит (S-V28 п.10ж): из него читают признак
    // входа, и читают в момент открытия экрана. Значение `true` — не «всегда перезапрашивать»:
    // запрос уходит, только если ответ устарел по `staleTime` **или** помечен инвалидацией.
    refetchOnMount: true,
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
 *
 * Различимых исхода **три** (микроревизия 1.12.1): успех целиком; «удалён у вас, но на сервере не
 * отозван» с причиной по `revoke_error`; «удалён у вас, связаться с сервером не удалось». Второй и
 * третий сливать запрещено: «точно не отозван» и «неизвестно» — разные факты (S-A16).
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
        } else if (result.hub === "not_revoked") {
          // Сервер ответил и ключ **не** отозвал: причина известна, и ключ модели может остаться
          // живым (S-A14 п.1). Предупреждение, а не ошибка: действие выполнено (D-49).
          showToast({
            variant: "default",
            title: language.t("corp.logout.notRevoked", {
              reason: language.t(logoutReasonKey(result.revoke_error)),
            }),
          })
        } else if (result.hub === "unavailable") {
          // О судьбе ключа не известно ничего — и текст этого случая отличается от предыдущего.
          showToast({
            variant: "default",
            title: language.t("corp.logout.revokeFailed", {
              reason: language.t("corp.logout.reason.unreachable"),
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
    // S-V28 п.10ж: сорванный ответ не значит «сервер ничего не сделал» — ключ мог быть уже удалён,
    // а ответ потерян по дороге. Экран, читающий из кэша, обязан перечитать и в этой ветке: иначе
    // «Выйти» в заголовке переживёт собственный выход.
    onError: async (error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
      await invalidate()
    },
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
    // S-V28 п.10ж: конфиг мог быть уже переписан, а ответ потерян — предупреждение в заголовке
    // витрины читается из статуса, и перечитать его нужно в обеих ветках, не только в успешной.
    onError: async (error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
      await invalidate()
    },
  }))
}

/**
 * Локальная копия каталога (stale-while-revalidate): persists between dialog opens
 * so the connectors dialog shows instantly on repeat opens. Only cached when the
 * response has real servers (not `hub_error: unauthorized`), so a pre-login response
 * never appears as placeholder after login.
 */
const CATALOG_LS_KEY = "corp.catalog.v1"

function readCatalogCache(): CorpCatalogView | undefined {
  try {
    const raw = localStorage.getItem(CATALOG_LS_KEY)
    if (!raw) return undefined
    const data = JSON.parse(raw) as CorpCatalogView
    if (data.hub_error || !data.servers || data.servers.length === 0) return undefined
    return data
  } catch {
    return undefined
  }
}

function writeCatalogCache(data: CorpCatalogView) {
  if (data.hub_error || !data.servers || data.servers.length === 0) return
  try {
    localStorage.setItem(CATALOG_LS_KEY, JSON.stringify(data))
  } catch {
    // localStorage may be full or unavailable — non-fatal, query still works
  }
}

export function useCorpCatalog(enabled: () => boolean) {
  const sdk = useServerSDK()
  return useQuery(() => ({
    queryKey: [sdk().scope, "corp.catalog"] as const,
    queryFn: (): Promise<CorpCatalogView> =>
      sdk()
        .client.corp.catalog()
        .then((response) => {
          const data = required(response.data)
          writeCatalogCache(data)
          return data
        }),
    enabled: enabled(),
    /**
     * Витрина открывается заново — каталог перезапрашивается, если ответ устарел (S-V28 п.10ж).
     *
     * Отказ Hub приходит **успешным** ответом с полем `hub_error` (S-V12 п.4), а не ошибкой
     * запроса: для клиента это обычные данные, которые ложатся в кэш и живут там как валидные.
     * При `refetchOnMount: false` — умолчании клиента приложения (`app.tsx`, `context/global.tsx`)
     * — такой ответ переживал и вход, и повторное открытие витрины: тело экрана говорило
     * «Требуется вход», пока заголовок уже показывал логин и «Выйти».
     *
     * Пара `staleTime` + `refetchOnMount` — не «всегда перезапрашивать»: в пределах `staleTime`
     * повторное открытие витрины берёт ответ из кэша и в сеть не ходит. Запрос уходит ровно тогда,
     * когда ответ устарел по времени **или** помечен инвалидацией — то есть после действия, после
     * которого из каталога читают (S-V28 п.10ж).
     */
    staleTime: 30_000,
    refetchOnMount: true,
    retry: false,
    // Витрина сама показывает «Hub недоступен» по пустым данным — ошибка не должна всплывать
    // в ErrorBoundary приложения (BUG-I4-002).
    throwOnError: false,
    // Stale-while-revalidate: показываем последнюю успешную копию каталога из localStorage
    // моментально, пока фоновый запрос обновляет данные. `isLoading` = false при наличии
    // placeholder, поэтому пустые состояния не мигают.
    placeholderData: () => readCatalogCache(),
  }))
}

/**
 * Prefetch каталога тем же ключом и queryFn, что `useCorpCatalog` (S-D7).
 *
 * Запускается из `finish()` экрана входа **до** `dialog.close()`: пока витрины нет,
 * запрос уходит вхолостую и ложится в кэш. Когда `dialog.close()` монтирует витрину,
 * `useCorpCatalog` находит свежую запись — `refetchOnMount: true` не перезапрашивает,
 * потому что ответ моложе `staleTime`. Если prefetch ещё в полёте, TanStack Query
 * дедуплицирует: `useQuery` присоединяется к тому же запросу, а не запускает второй.
 */
export function useCorpPrefetchCatalog() {
  const sdk = useServerSDK()
  const client = useQueryClient()
  return () =>
    client.prefetchQuery({
      queryKey: [sdk().scope, "corp.catalog"] as const,
      queryFn: (): Promise<CorpCatalogView> =>
        sdk()
          .client.corp.catalog()
          .then((response) => {
            const data = required(response.data)
            writeCatalogCache(data)
            return data
          }),
      staleTime: 30_000,
      retry: false,
    })
}

/**
 * Инвалидация после действий витрины и входа/выхода: каталог, статус и локальные статусы MCP
 * (S-D7, S-V28 п.10ж).
 *
 * Пометка «устарело» распространяется на **все** совпавшие запросы, но перезапрашиваются ей только
 * те, у которых сейчас есть подписчик (умолчание `refetchType: "active"`). Ответы без подписчика
 * оставались бы в кэше телом, снятым **до** действия, — и следующий экран прочитал бы из них
 * свидетельство, которого действие уже лишило смысла. Ровно это давало «Требуется вход» на витрине
 * при живом ключе: вход происходил на экране входа, витрина в этот момент была уничтожена
 * (`dialog.show`), её каталог подписчика не имел и потому не перезапрашивался, а `refetchOnMount`
 * у клиента приложения выключен глобально.
 *
 * Поэтому неактивные ответы не помечаются, а **удаляются**: у них нет читателя, которому важно
 * увидеть переход, зато есть тело, пережившее действие. Следующее открытие экрана начнёт с запроса,
 * а не с чужого прошлого. Кэш при этом остаётся кэшем: без действия ничего не удаляется, и
 * повторное открытие того же экрана в сеть не ходит.
 */
export function useCorpInvalidate() {
  const client = useQueryClient()
  const sdk = useServerSDK()
  return async () => {
    const scope = sdk().scope
    const matches = (queryKey: readonly unknown[]) => {
      if (queryKey[0] !== scope) return false
      // Корп-ключи — на уровне сервера, ключи MCP — на уровне рабочего каталога
      // (`[scope, directory, "mcp"]`): после действия витрины обновляются все каталоги сервера.
      if (queryKey[1] === "corp.catalog" || queryKey[1] === "corp.status") return true
      return queryKey[2] === "mcp"
    }
    const refetched = client.invalidateQueries({ predicate: (query) => matches(query.queryKey) })
    client.removeQueries({ predicate: (query) => matches(query.queryKey) && !query.isActive() })
    await refetched
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
  /**
   * Режимы **отдельных инструментов** (S-V23, ревизия 1.14) — то же тело, что `permissionModes`,
   * с добавленным разделом `tools`. Отдельным роутом это не является и вторым видом тела тоже:
   * `modes` по-прежнему обязателен и задаёт умолчание блока, включая режим wildcard группы
   * «Остальное», а `tools` — поимённые исключения поверх него. В теле идут **все** показанные
   * инструменты, а не один изменённый: запись перезаписывает блок alias целиком (S-V21).
   */
  | {
      kind: "permissionTools"
      alias: string
      modes: Record<string, CorpPermissionMode>
      tools: Record<string, CorpPermissionMode>
    }


/**
 * Прямое подключение токеном (S-V25, S-D13, ревизия 1.13).
 *
 * Отдельная мутация, а не ветка `useConnectorAction`: её исход показывается **в той же форме**, а
 * не всплывающим окном (S-D13 п.6), поэтому вызывающему нужен сам ответ роута, а не тост. Значение
 * токена живёт только в состоянии смонтированного компонента и не сохраняется нигде — ни в адресе
 * страницы, ни в хранилище браузера, ни в состоянии витрины (S-D13 п.6, S-V26 п.6).
 *
 * Проверка, обмен, сохранение и запрет живут на сервере и здесь не дублируются ни строкой
 * (S-T12): оболочка отправляет тело и показывает пришедшие исходы.
 */
export interface ConnectTokenInput {
  alias: string
  /** `id` способа; не передаётся, когда применимый способ у карточки ровно один (S-V25 п.1). */
  method?: string
  token: string
}

/**
 * Отказ роута прямого подключения — **не** исход проверки (S-V25 п.3): исходы приходят кодом `200`
 * и разбираются формой, а сюда попадают отказы предпроверок и хранилища.
 */
export interface ConnectTokenFailure {
  /** Стабильный код ошибки роута: `invalid_request`, `auth_method_unavailable`, … (S-A5). */
  code: string
  /** Причина недоступности способа, если роут её назвал (S-V28 п.1). */
  unavailableCode?: string
}

/** Ключ словаря по коду отказа роута (S-I1): «Сохранить токен не удалось» и причины S-V28 п.1. */
export function connectFailureKey(failure: ConnectTokenFailure | undefined) {
  if (!failure) return undefined
  if (failure.code === "storage_unavailable") return "corp.connect.storageUnavailable" as const
  if (failure.code === "auth_method_unavailable") return methodUnavailableKey(failure.unavailableCode)
  // Форма ввода токена открывается и у фасадной карточки (решение заказчика от 31.08, вечер), а
  // роут отвечает `direct_unavailable`, когда в карточке каталога не разобран блок `upstream`: тогда
  // приложению НЕКУДА отправить токен. Без этой ветви форма молчала бы — человек нажал «Подключить»
  // и не узнал ничего. Проверка и обмен при этом не тронуты: где им ходить, по-прежнему решает
  // каталог, а этот ключ только называет пришедший отказ.
  if (failure.code === "direct_unavailable") return "corp.connect.directUnavailable" as const
  return undefined
}

/**
 * Ключ причины недоступности способа (S-V28 п.1, S-I1) — три **разных** ключа, потому что причины
 * разные и советы разные. Неизвестный код падает в причину каталога: «так решил каталог» — самая
 * общая из трёх и единственная, не обещающая пользователю ничего конкретного.
 */
export function methodUnavailableKey(code: string | null | undefined) {
  if (code === "oauth_disabled") return "corp.connectors.methodUnavailable.oauthDisabled" as const
  if (code === "env_header") return "corp.connectors.methodUnavailable.envHeader" as const
  return "corp.connectors.methodUnavailable.catalog" as const
}

/** Разбор тела отказа роута: код и, если он назван, `unavailable_code` (S-A5, S-V28 п.1). */
export function connectTokenFailure(error: unknown): ConnectTokenFailure {
  const body = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined
  const code = typeof body?.["error"] === "string" ? (body["error"] as string) : "unknown"
  const unavailable = typeof body?.["unavailable_code"] === "string" ? (body["unavailable_code"] as string) : undefined
  return { code, ...(unavailable === undefined ? {} : { unavailableCode: unavailable }) }
}

export function useConnectToken() {
  const sdk = useServerSDK()
  const invalidate = useCorpInvalidate()

  return useMutation(() => ({
    mutationFn: (input: ConnectTokenInput): Promise<CorpConnectTokenResult> =>
      sdk()
        .client.corp.connectorConnectToken({
          alias: input.alias,
          body: { ...(input.method === undefined ? {} : { method: input.method }), token: input.token },
        })
        .then((response) => {
          if (response.error !== undefined) throw response.error
          return required(response.data)
        }),
    // Витрина и локальные статусы MCP обновляются после успеха: карточка обязана показать то же
    // состояние, что покажет следующее открытие витрины (S-V15).
    onSuccess: async () => {
      await invalidate()
    },
    // S-V28 п.10ж: исход проверки токена показывает сама форма (S-D13 п.6), тост здесь не нужен —
    // но сохранение могло состояться и при сорванном ответе, и витрина за формой обязана это
    // увидеть. Ошибку обработчик не гасит: `useConnectToken` по-прежнему отдаёт её вызывающему.
    onError: async () => {
      await invalidate()
    },
  }))
}

/**
 * Ключ исхода отзыва (S-V27 п.2, S-I1). Исход `skipped` показывать нечего — ключа под него нет, и
 * сюда он не попадает: «отзывать было нечего» пользователю не сообщается вовсе.
 */
export function revokeKey(result: "revoked" | "not_revoked" | "unreachable" | "skipped") {
  if (result === "revoked") return "corp.connect.revoke.revoked" as const
  if (result === "not_revoked") return "corp.connect.revoke.notRevoked" as const
  return "corp.connect.revoke.unreachable" as const
}

/**
 * Заголовок тоста, когда сорвался САМ запрос действия (S-V19, S-I1).
 *
 * Заголовок называет, что не получилось, а не то, каким способом это выяснилось: у «Подключить»
 * это «Подключение не удалось» — тот же текст, каким тот же отказ назван на карточке и в тосте
 * успешного ответа с полем `error`. У прочих действий отдельного текста в словаре нет, и общий
 * «Запрос не выполнен» честнее выдуманного: он говорит ровно то, что известно.
 */
export function actionFailureTitleKey(kind: ConnectorAction["kind"]) {
  return kind === "connect" ? ("corp.connectors.neverConnected" as const) : ("common.requestFailed" as const)
}

/**
 * Полный технический текст сорвавшегося запроса — то, что кладётся в ПОДСКАЗКУ, и только туда.
 *
 * Отдельно от {@link actionFailureDetail} потому, что у этих двух текстов разные места и разные
 * права: подсказка терпит длинную многострочную техническую строку (её читают, наведя мышь и
 * решив прочитать), а видимый текст отказа — нет.
 */
export function actionFailureText(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  // Верхняя граница есть и у подсказки: она живёт в атрибуте `title`, и дамп конфига на несколько
  // экранов подсказкой быть перестаёт.
  return trimmed.length > HINT_LIMIT ? trimmed.slice(0, HINT_LIMIT) + "…" : trimmed
}

/** Предел подсказки: столько технического текста человек ещё способен прочитать наведением. */
const HINT_LIMIT = 2000

/**
 * Сколько технического текста имеет право попасть в ВИДИМЫЙ текст отказа как «Код ошибки: …».
 * Код ошибки — короткая строка в одну строчку; всё, что длиннее, кодом не является.
 */
const DETAIL_LIMIT = 120

/**
 * Технический код сорвавшегося запроса — то, что попадает в текст отказа рядом с объяснением
 * (S-V19), и **только** когда это действительно код.
 *
 * В основной текст она не попадает никогда и не показывается вовсе, когда её нет: пустая строка
 * подсказкой не становится, и «Код ошибки:» с пустотой после двоеточия на экране не появляется —
 * ровно тот дефект, который ревизия 1.14 убрала у класса `unknown` (DISPUTE-I14-03).
 *
 * Ревизия 1.14, второй дефект того же места: сюда приходит `error.message`, а у отказа разбора
 * конфига это НЕ код, а весь файл целиком — `\n--- JSONC Input ---\n{ … }\n--- Errors ---\n…`.
 * Заказчик получил тост, в котором после «Код ошибки:» шёл дамп его собственного `opencode.jsonc`.
 * Правило теперь описывает не «непустая строка», а «код»: одна строка, не длиннее
 * {@link DETAIL_LIMIT}. Всё прочее из видимого текста уходит — человеку остаётся честное «причину
 * система не назвала», а полный текст живёт в подсказке ({@link actionFailureText}) и в логе
 * сервера. Прятать техническую строку от того, кому она нужна, при этом не приходится: подсказку
 * показывает то место, где у отказа есть свой знак — строка разрешений.
 */
export function actionFailureDetail(error: unknown): string | undefined {
  const text = actionFailureText(error)
  if (text === undefined) return undefined
  if (text.length > DETAIL_LIMIT) return undefined
  if (text.includes("\n")) return undefined
  return text
}

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
      if (action.kind === "permissionTools")
        return sdk()
          .client.corp.permissions({ alias: action.alias, modes: action.modes, tools: action.tools })
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
        // S-V19, ревизия 1.14: заголовок называет, что случилось, человеческими словами
        // («Подключение не удалось»), а не общим «Request failed» оболочки; объяснение класса идёт
        // текстом, код ошибки — отдельным предложением и только когда он есть. Прежде код
        // подставлялся в текст класса И приписывался в скобках, а приходит он от MCP-службы пустой
        // строкой всякий раз, когда причина ей неизвестна: пользователь видел двоеточие и пустоту.
        const code = result.error.trim()
        const explained =
          "error_class" in result && result.error_class
            ? language.t(connectErrorKey(result.error_class))
            : language.t(connectErrorKey(undefined))
        const details = code ? language.t("corp.error.connect.details", { code }) : undefined
        showToast({
          variant: "error",
          title: language.t("corp.connectors.neverConnected"),
          description: details ? `${explained}. ${details}` : explained,
        })
      }
      // S-V27 п.2: исход отзыва выпущенного токена — закрытый набор из четырёх значений. `skipped`
      // («звать было некого») не показывает ничего; прочие три различимы и сливать их запрещено.
      if (result && "revoke" in result && result.revoke && result.revoke !== "skipped") {
        showToast({
          variant: result.revoke === "revoked" ? "success" : "default",
          title: language.t(revokeKey(result.revoke)),
        })
      }
      if (result && "reauth_required" in result && result.reauth_required) {
        showToast({ variant: "default", title: language.t("corp.connectors.reauth") })
      }
      await invalidate()
    },
    // S-V28 п.10ж: у действий витрины локальная часть выполняется до ответа Hub (S-V17), поэтому
    // сорванный запрос — не «ничего не произошло». Карточка обязана показать то, что на сервере,
    // а не то, что было до нажатия.
    //
    // S-V19 (ревизия 1.14): отказ, пришедший ИСКЛЮЧЕНИЕМ, говорит с пользователем теми же словами,
    // что и отказ, пришедший полем `error` успешного ответа. Прежде текст исключения уходил в тост
    // как есть, и на стенде на первом же клике «Подключить» у неподключённой карточки появлялось
    // «Запрос не выполнен / Expected object, got undefined» — английская фраза про схему тела
    // запроса. Класс отказа здесь неизвестен (его считает сервер, а сюда попадает случай, когда
    // сервер до ответа не дошёл), и клиент правило сервера не повторяет (S-T12): пользователю
    // достаётся честное «причину система не назвала» и предлагаемый шаг, а техническая строка —
    // отдельным предложением-подсказкой и только когда она непуста.
    onError: async (error, action) => {
      const detail = actionFailureDetail(error)
      const explained = language.t("corp.error.request.unknown")
      showToast({
        variant: "error",
        title: language.t(actionFailureTitleKey(action.kind)),
        description: detail
          ? `${explained}. ${language.t("corp.error.connect.details", { code: detail })}`
          : explained,
      })
      await invalidate()
    },
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

const CONNECT_ERROR_CLASSES = [
  "token_rejected",
  "method_unavailable",
  "network_unreachable",
  "upstream_unavailable",
  "hub_unreachable",
  "unknown",
] as const

/**
 * Ключ словаря по классу ошибки подключения (S-V19, S-I1).
 * Неизвестный класс падает в `unknown`: «ошибка без объяснения» — дефект, а не состояние (D-32).
 */
export function connectErrorKey(errorClass: string | undefined) {
  const known = CONNECT_ERROR_CLASSES.find((entry) => entry === errorClass)
  return `corp.error.connect.${known ?? "unknown"}` as `corp.error.connect.${(typeof CONNECT_ERROR_CLASSES)[number]}`
}

/**
 * Причины отказа отзыва ключа — **закрытый набор** (S-A14 п.1, S-I1, микроревизия 1.12.1).
 *
 * Ключ словаря выбирается по коду `revoke_error`, пришедшему от Hub дословно; поле `message`
 * ответа Hub не пересылается и не показывается (S-A5).
 */
const REVOKE_ERROR_KEYS = {
  not_permitted: "notPermitted",
  upstream_unavailable: "upstreamUnavailable",
  invalid_response: "invalidResponse",
} as const

/**
 * Ключ словаря по коду `revoke_error` (S-A14 п.1, S-I1).
 *
 * Неизвестный код — не повод показать код машины человеку: показывается
 * `corp.logout.reason.invalidResponse`, а сам код называет лог сервера (запись `corp logout`).
 */
export function logoutReasonKey(code: string | undefined) {
  const known = code === undefined ? undefined : REVOKE_ERROR_KEYS[code as keyof typeof REVOKE_ERROR_KEYS]
  return `corp.logout.reason.${known ?? "invalidResponse"}` as `corp.logout.reason.${(typeof REVOKE_ERROR_KEYS)[keyof typeof REVOKE_ERROR_KEYS]}`
}

/** Ключ словаря по стабильному коду ошибки корп-роутов (S-A5, S-I1). */
export function corpErrorKey(code: string | undefined) {
  const known = ERROR_KEYS.find((entry) => entry === code)
  return `corp.error.${known ?? "unknown"}` as `corp.error.${(typeof ERROR_KEYS)[number] | "unknown"}`
}
