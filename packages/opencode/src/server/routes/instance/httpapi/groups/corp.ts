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
    ]),
  },
  { httpApiStatus: 400 },
) {}

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
 */
export const PermissionsPayload = Schema.Struct({
  preset: Schema.optional(Schema.String),
  groups: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  modes: Schema.optional(Schema.Record(Schema.String, CorpSchema.PermissionMode)),
})

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
          error: [CorpDisabledError, CorpBadRequestError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "corp.connect",
            summary: "Connect connector",
            description:
              "Пишет mcp.<alias> в глобальный конфиг и запускает штатный MCP-OAuth. В сборке без Hub карточка mode:facade отвергается (facade_needs_hub) и запись не создаётся.",
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
