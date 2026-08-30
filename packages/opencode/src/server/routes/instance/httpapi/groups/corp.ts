import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as CorpSchema from "@/corp/schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

/**
 * Корпоративные роуты (S-A1, S-V1).
 *
 * Весь обмен с Hub идёт отсюда (D-2): UI знает только эти маршруты, `poll_secret` и ключ провайдера
 * наружу не отдаются. При выключенных корп-функциях (S-C5) каждый маршрут отвечает
 * `501 {"error":"corp_disabled"}`.
 */

export class CorpDisabledError extends Schema.ErrorClass<CorpDisabledError>("CorpDisabledError")(
  { error: Schema.Literal("corp_disabled") },
  { httpApiStatus: 501 },
) {}

/** Ошибка обращения к Hub со стабильным кодом (S-A5); тексты Hub наружу не пересылаются. */
export class CorpHubError extends Schema.ErrorClass<CorpHubError>("CorpHubError")(
  { error: CorpSchema.HubErrorCode, retry_after: Schema.optional(Schema.Number) },
  { httpApiStatus: 502 },
) {}

/**
 * Ошибка запроса корп-роута (S-V1, ревизия 1.10): тело не годится и **ничего не записывается**.
 *
 * Отдельный класс, а не `CorpHubError`: Hub здесь ни при чём — у вида `permission_groups` запроса к
 * нему не выполняется вовсе (D-35), а 502 сказал бы пользователю неправду о причине.
 *
 * **Ревизия 1.11 (S-C10 п.7–8).** Сюда же добавлены два отказа сборки без Hub: `facade_needs_hub` —
 * «Подключить» у карточки `mode:"facade"` (S-V7) и `permissions_need_hub` — тело `{preset}` у
 * Hub-зависимых видов модели прав (S-V9). Это не `corp_disabled`: корп-функции включены, каталог
 * работает — недоступен ровно один шов, и он назван. Ни один из них ничего не записывает; текст
 * пользователю подставляет оболочка по ключам `corp.connectors.facadeNeedsHub` и
 * `corp.connectors.permissionsNeedHub` (S-I1).
 */
export class CorpBadRequestError extends Schema.ErrorClass<CorpBadRequestError>("CorpBadRequestError")(
  {
    error: Schema.Literals([
      "conflicting_body",
      "missing_body",
      "permission_groups_unavailable",
      "facade_needs_hub",
      "permissions_need_hub",
      // S-V29 п.1: один alias — одно подключение. Подключить фасадным способом alias, у которого
      // есть действующие прямые учётные данные, нельзя, пока они не удалены отключением: смена
      // способа означает смену того, кто хранит учётные данные, и молчаливой она не бывает.
      "direct_connected",
    ]),
  },
  { httpApiStatus: 400 },
) {}

/**
 * Ошибка запроса прямого подключения (S-V25 п.1, строки 2, 4 и 6).
 *
 * Строки 2, 4 и 6 таблицы дают один и тот же код и различаются только моментом срабатывания — это
 * не три разных исхода, и различать их пользователю не требуется. `message` называет, что именно
 * не годится в запросе; текста целевой системы в нём нет.
 */
export class CorpInvalidRequestError extends Schema.ErrorClass<CorpInvalidRequestError>("CorpInvalidRequestError")(
  { error: Schema.Literal("invalid_request"), message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Alias отсутствует в действующем каталоге (S-V25 п.1, строка 1). */
export class CorpNotFoundError extends Schema.ErrorClass<CorpNotFoundError>("CorpNotFoundError")(
  { error: Schema.Literal("not_found") },
  { httpApiStatus: 404 },
) {}

/**
 * Способ подключения недоступен (S-V28 п.5): тот же код и то же имя ошибки, что у Hub (I-3 R-U7), —
 * совпадение намеренное: механизм один, меняется только место, где он живёт.
 *
 * Отказ выдаётся **до единого исходящего запроса** и до любой записи: ни `mcp.<alias>` в конфиге,
 * ни записи в хранилище, ни открытого браузера. Запрос, посланный мимо интерфейса (curl, скрипт,
 * старая сборка оболочки), получает тот же ответ, что и кнопка.
 */
export class CorpAuthMethodUnavailableError extends Schema.ErrorClass<CorpAuthMethodUnavailableError>(
  "CorpAuthMethodUnavailableError",
)(
  {
    error: Schema.Literal("auth_method_unavailable"),
    unavailable_code: Schema.Literals(["catalog_unavailable", "oauth_disabled", "env_header"]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

/** У карточки не разобран блок `upstream` — прямым режимом она не подключается (S-V25 п.1, строка 5). */
export class CorpDirectUnavailableError extends Schema.ErrorClass<CorpDirectUnavailableError>(
  "CorpDirectUnavailableError",
)({ error: Schema.Literal("direct_unavailable"), message: Schema.String }, { httpApiStatus: 409 }) {}

/**
 * Сохранить учётные данные не удалось (S-V26 п.5, первый случай).
 *
 * Отказ записи **фатален**, в отличие от кэша каталога и признака подключений: карточка,
 * объявленная подключённой без сохранённого токена, подключиться уже не сможет и будет врать
 * пользователю при каждом запуске.
 */
export class CorpStorageUnavailableError extends Schema.ErrorClass<CorpStorageUnavailableError>(
  "CorpStorageUnavailableError",
)({ error: Schema.Literal("storage_unavailable"), message: Schema.String }, { httpApiStatus: 500 }) {}

export const TeamPayload = Schema.Struct({ team_id: Schema.String })
export const ConnectPayload = Schema.Struct({ preset: Schema.optional(Schema.String) })

/**
 * Тело роута прав (S-V1, ревизия 1.10) — два взаимоисключающих вида.
 *
 * Прежний `{preset}` (виды `header_groups` / `tool_filter` / `consent`, S-V9) не изменён; новый
 * `{modes: {<groupId>: allow|ask|deny}}` — вид `permission_groups` (S-V20, S-V21), где ключ `rest`
 * задаёт режим группы «Остальное». Схема допускает оба поля необязательными, потому что
 * взаимоисключение — правило запроса, а не формы: одновременная передача обоих отвергается
 * `CorpBadRequestError`, и это же отличает её от «поле пропущено» в диагностике клиента.
 *
 * **Ревизия 1.14** добавила к виду `{modes}` необязательный спутник `{tools: {<toolName>: mode}}` —
 * режимы отдельных инструментов. Третьим видом тела он не является и в одиночку не принимается:
 * `modes` задаёт умолчание блока (в том числе wildcard группы «Остальное»), `tools` — поимённые
 * исключения поверх него. Тело без `modes`, но с `tools` отвергается как `missing_body`: запись
 * блока детерминирована и обязана знать режим wildcard, а угадывать его сервер не станет.
 */
export const PermissionsPayload = Schema.Struct({
  preset: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  modes: Schema.optional(Schema.Record(Schema.String, CorpSchema.PermissionMode)),
  tools: Schema.optional(Schema.Record(Schema.String, CorpSchema.PermissionMode)),
})

/**
 * Тело прямого подключения (S-V25): `{method?: string, token: string}`.
 *
 * Схема намеренно **не** проверяет состав: все пять предпроверок выполняет обработчик и в
 * обязательном порядке (S-V25 п.1). Иначе тело, не являющееся объектом, отвергал бы декодер своей
 * ошибкой другой формы, а критерий требует ровно `400 {error:"invalid_request", message}`.
 */
export const ConnectTokenPayload = Schema.Unknown

export const CatalogQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  refresh: Schema.optional(Schema.String),
})

export const CorpPaths = {
  loginStart: "/corp/login/start",
  loginPoll: "/corp/login/poll/:loginID",
  loginTeam: "/corp/login/poll/:loginID/team",
  loginCancel: "/corp/login/poll/:loginID",
  // corp: выход (S-A14). Ресурс — сессия пользователя целиком, а не сессия входа: `POST`, потому
  // что действие состоит из двух шагов на двух сторонах и описывает исход каждого.
  logout: "/corp/logout",
  status: "/corp/status",
  // corp: действие «Включить» (S-C11 п.4) — снятие `magnit_prod` с `disabled_providers` личного
  // конфига. Пути для него спека не называет; имя выбрано по образцу соседей группы.
  providerEnable: "/corp/provider/enable",
  catalog: "/corp/catalog",
  connect: "/corp/connectors/:alias/connect",
  disconnect: "/corp/connectors/:alias/disconnect",
  // corp: «Убрать из списка» (S-V17) — DELETE самой записи, а не подчинённого ресурса: действие
  // удаляет `mcp.<alias>` из конфига, чего «Отключить» не делает.
  forget: "/corp/connectors/:alias",
  permissions: "/corp/connectors/:alias/permissions",
  // corp: прямое подключение токеном (S-V25). Отдельный путь рядом с `connect`, а не второе тело
  // того же роута: у действий разный состав шагов и разные исходы, и сливать их значило бы
  // прятать в одном ответе два закрытых набора.
  connectToken: "/corp/connectors/:alias/connect-token",
} as const

export const CorpApi = HttpApi.make("corp")
  .add(
    HttpApiGroup.make("corp")
      .add(
        HttpApiEndpoint.post("loginStart", CorpPaths.loginStart, {
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LoginStart, "Корпоративный вход начат"),
          error: [CorpDisabledError, CorpHubError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.start",
            summary: "Start corporate SSO login",
            description: "Начинает вход через корпоративный SSO: возвращает код и адрес для браузера.",
          }),
        ),
        HttpApiEndpoint.get("loginPoll", CorpPaths.loginPoll, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LoginPoll, "Состояние входа"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.poll",
            summary: "Poll corporate SSO login",
            description: "Опрашивает Hub о состоянии входа; poll_secret наружу не отдаётся.",
          }),
        ),
        HttpApiEndpoint.post("loginTeam", CorpPaths.loginTeam, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: TeamPayload,
          success: described(CorpSchema.LoginPoll, "Команда выбрана"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.team",
            summary: "Select team for corporate SSO login",
            description: "Отправляет выбранную команду в Hub и возвращает состояние входа.",
          }),
        ),
        HttpApiEndpoint.delete("loginCancel", CorpPaths.loginCancel, {
          params: { loginID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LoginCancel, "Сессия входа освобождена"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.login.cancel",
            summary: "Cancel corporate SSO login",
            description: "Освобождает сессию входа в памяти сервера при закрытии экрана (S-A9).",
          }),
        ),
        HttpApiEndpoint.post("logout", CorpPaths.logout, {
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.LogoutResult, "Выход выполнен"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.logout",
            summary: "Sign out of corporate SSO",
            description:
              "Отзывает ключ на стороне Hub (best effort) и безусловно удаляет его из auth-store. Ответ описывает обе части по отдельности. Коннекторы, разрешения и кэш каталога не трогает.",
          }),
        ),
        HttpApiEndpoint.get("status", CorpPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.CorpStatus, "Состояние корпоративного режима"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.status",
            summary: "Corporate mode status",
            description:
              "Адрес Hub, наличие ключа, версия и свежесть кэша каталога, а также файл, в котором корп-провайдер выключен личным конфигом (provider_disabled).",
          }),
        ),
        HttpApiEndpoint.post("providerEnable", CorpPaths.providerEnable, {
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.ProviderEnableResult, "Провайдер включён обратно"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            // Двухсегментный идентификатор оставляет метод SDK плоским (`corp.providerEnable()`),
            // как у соседей группы; точка внутри имени завела бы отдельный вложенный класс.
            identifier: "corp.providerEnable",
            summary: "Re-enable the corporate provider",
            description:
              "Удаляет ровно один элемент magnit_prod из disabled_providers глобального конфига через Config.updateGlobal. Запись в слое, который приложение не правит, не трогается: ответ называет файл и причину.",
          }),
        ),
        HttpApiEndpoint.get("catalog", CorpPaths.catalog, {
          query: CatalogQuery,
          success: described(CorpSchema.CatalogView, "Каталог коннекторов"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.catalog",
            summary: "Connector catalog",
            description: "Каталог корпоративных MCP-серверов с состоянием карточек и деградацией на кэш.",
          }),
        ),
        HttpApiEndpoint.post("connect", CorpPaths.connect, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ConnectPayload,
          success: described(CorpSchema.ConnectorResult, "Коннектор подключён"),
          // S-C10 п.8: у карточки `facade` в сборке без Hub действие отвергается с названной причиной.
          // S-V28 п.5 (микроревизия 1.13.1): у закрытой `native`-карточки — `409` до единого
          // исходящего запроса и до создания ключа `mcp.<alias>`.
          error: [CorpDisabledError, CorpBadRequestError, CorpAuthMethodUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.connect",
            summary: "Connect connector",
            description:
              "Пишет mcp.<alias> в глобальный конфиг и запускает штатный MCP-OAuth. В сборке без Hub карточка mode:facade отвергается (facade_needs_hub) и запись не создаётся.",
          }),
        ),
        HttpApiEndpoint.post("connectToken", CorpPaths.connectToken, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ConnectTokenPayload,
          success: described(CorpSchema.ConnectTokenResult, "Прямое подключение выполнено"),
          error: [
            CorpDisabledError,
            CorpInvalidRequestError,
            CorpNotFoundError,
            CorpAuthMethodUnavailableError,
            CorpDirectUnavailableError,
            CorpStorageUnavailableError,
          ],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.connectorConnectToken",
            summary: "Connect connector with a token",
            description:
              "Проверяет введённый токен в целевой системе, при объявленном блоке обмена выпускает постоянный токен, сохраняет учётные данные в защищённом хранилище приложения и поднимает соединение с MCP-сервером напрямую. Ни Hub, ни браузера в пути нет; значение токена не возвращается ни в одном ответе.",
          }),
        ),
        HttpApiEndpoint.post("disconnect", CorpPaths.disconnect, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.ConnectorResult, "Коннектор отключён"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.disconnect",
            summary: "Disconnect connector",
            description: "Снимает OAuth-токены, гасит MCP и снимает подключение в Hub.",
          }),
        ),
        HttpApiEndpoint.delete("forget", CorpPaths.forget, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CorpSchema.ForgetResult, "Коннектор убран из списка"),
          error: CorpDisabledError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.forget",
            summary: "Forget connector",
            description: "Удаляет запись mcp.<alias> из конфига, снимает признак подключения и подключение в Hub.",
          }),
        ),
        HttpApiEndpoint.put("permissions", CorpPaths.permissions, {
          params: { alias: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: PermissionsPayload,
          success: described(CorpSchema.PermissionsResult, "Права обновлены"),
          error: [CorpDisabledError, CorpBadRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.permissions",
            summary: "Update connector permissions",
            description:
              "Тело {preset} — пресет прав в Hub и, для mode:facade, oauth.scope в конфиге. Тело {modes} — режимы групп вида permission_groups: запись в раздел permission конфига пользователя без обращения к Hub.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "corp",
          description: "Корпоративные роуты: вход по SSO и витрина коннекторов.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
