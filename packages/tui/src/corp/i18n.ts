import { corpEnabled } from "@opencode-ai/core/corp/constants"

/**
 * Минимальный словарь корпоративных экранов TUI (S-I4, S-I5).
 *
 * Используется **только** нашими экранами; upstream-строки TUI не трогаются. Язык берётся из
 * `OPENCODE_CORP_LANG` (`ru`/`en`), иначе `ru` при включённых корп-функциях, иначе `en`.
 */

const ru = {
  "login.title": "Вход через корпоративный SSO",
  "login.hub": "Hub",
  "login.code": "Код",
  "login.open": "Откройте в браузере",
  "login.waiting": "Ожидание подтверждения…",
  "login.copy": "скопировать код",
  "login.retry": "повторить",
  "login.otherProvider": "другой провайдер",
  "login.teamTitle": "Выберите команду",
  "login.success": "Вход выполнен",
  "login.cancelled": "Вход отменён",
  // S-C5, S-C10 п.6: вход по SSO остаётся зависимым от Hub. Слова «Hub» в тексте нет — в сборке
  // без него оно пользователю не показывается нигде (D-43).
  "login.needsHub": "Вход по корпоративному SSO в этой сборке не настроен",

  "connectors.title": "Коннекторы",
  "connectors.command": "Витрина коннекторов",
  "connectors.loginCommand": "Вход через корпоративный SSO",
  "connectors.search": "Поиск",
  "connectors.empty": "Каталог пуст",
  "connectors.hubDown": "Hub недоступен",
  "connectors.hubDownCached": "Hub недоступен, данные от",
  "connectors.needsLogin": "Требуется вход",
  "connectors.refresh": "обновить",
  "connectors.connect": "подключить",
  "connectors.reconnect": "переподключить",
  "connectors.disconnect": "отключить",
  "connectors.permissions": "права",
  "connectors.openHub": "открыть в Hub",
  "connectors.login": "войти",
  "connectors.authorizing": "⋯ Авторизация в браузере",
  "connectors.deprecated": "устаревший",
  "connectors.stale": "данные устарели, действия недоступны",
  "connectors.presetTitle": "Права коннектора",
  "connectors.permissionsUnavailable":
    "Модель прав не поддерживается этой версией приложения — правами можно управлять в Hub",
  // Та же причина без совета идти в Hub — текст последней строки таблицы S-V9 в сборке без Hub
  // (микроревизия 1.11.1). Ключ выше не переименовывается и не переписывается: он остаётся
  // текстом сборки С Hub, где совет верен.
  "connectors.permissionsUnavailableNoHub": "Выбор прав для этого коннектора не поддерживается этой версией приложения",
  "connectors.reauth": "Требуется повторная авторизация",
  "connectors.connected": "Подключено",
  "connectors.retry": "повторить",
  "connectors.forget": "убрать из списка",
  // Действие доступно и в сборке без Hub, поэтому подтверждение обещает снятие подключения
  // на сервере, а не «в Hub», и оговаривает условие: шага может не быть вовсе (S-V17, 1.11.1).
  "connectors.forgetConfirm":
    "Убрать «{{title}}» из списка? Запись коннектора будет удалена из вашего конфига, а подключение на сервере будет снято, если сервер настроен и доступен",
  "connectors.forgetHubFailed": "Запись удалена локально, но Hub не ответил",
  "connectors.neverConnected": "Подключение не удалось",
  "connectors.lost": "Соединение потеряно",
  "connectors.disconnected": "Отключено вами",
  "connectors.notConnectedHint": "Отключать нечего: подключения нет",

  // Вкладки фильтра витрины и их пустые состояния (S-V11, S-V12, S-T10, ревизия 1.10).
  "connectors.tabAll": "Все",
  "connectors.tabConnected": "Подключённые",
  "connectors.tabNotConnected": "Неподключённые",
  "connectors.columnName": "Имя",
  "connectors.columnType": "Тип",
  "connectors.columnStatus": "Статус",
  "connectors.resetFilter": "Показать все",
  "empty.tabConnected": "Пока ничего не подключено",
  "empty.tabNotConnected": "Подключено всё",
  "empty.unparsed": "Каталог не разобран: отброшены все карточки ({{dropped}})",
  "connectors.partial": "Часть карточек каталога не разобрана и не показана: {{dropped}}",

  // Сборка без Hub (S-C10, ревизия 1.11). Ни один из трёх текстов не называет Hub (D-43):
  // недоступный источник называется каталогом, а причины швов — «в этой сборке».
  "connectors.catalogUnavailable": "Каталог недоступен: получить список коннекторов не удалось",
  "connectors.facadeNeedsHub": "Подключение этого коннектора в этой сборке не настроено",
  "connectors.permissionsNeedHub": "Управление правами этого коннектора в этой сборке не настроено",

  // Страница коннектора (S-D11, S-T10).
  "connector.back": "Назад",
  "connector.owner": "Владелец",
  "connector.type": "Тип",
  "connector.docs": "Документация",

  // Экран разрешений по группам (S-V20, S-V23).
  "permissions.title": "Разрешения",
  "permissions.allow": "Разрешить",
  "permissions.ask": "Спрашивать",
  "permissions.deny": "Запретить",
  "permissions.allowAll": "Разрешить всё",
  "permissions.denyAll": "Запретить всё",
  "permissions.mixed": "Смешанно",
  "permissions.restTitle": "Остальные возможности",
  "permissions.restDescription": "Инструменты коннектора, не попавшие ни в одну группу выше",
  "permissions.saved": "Разрешения сохранены",

  "status.connected": "✓ Подключён",
  "status.needs_auth": "⚠ Требуется авторизация",
  "status.not_connected": "○ Не подключён",
  "status.unavailable": "✗ Недоступен",

  "preset.readonly": "только чтение",
  "preset.readwrite": "чтение и запись",

  "error.corp_disabled": "Корпоративный режим не настроен",
  "error.hub_unavailable": "Hub недоступен",
  "error.hub_invalid_response": "Hub вернул неожиданный ответ",
  "error.login_expired": "Сессия входа истекла",
  "error.forbidden": "Доступ запрещён",
  "error.invalid_team": "Неизвестная команда",
  "error.team_selection_not_required": "Выбор команды не требуется",
  "error.rate_limited": "Слишком много попыток, повторите позже",
  "error.litellm_unavailable": "Сервис ключей недоступен",
  "error.litellm_invalid_response": "Сервис ключей вернул неожиданный ответ",
  "error.unauthorized": "Нужен вход: ключ не найден",
  "error.not_found": "Не найдено",
  "error.invalid_request": "Некорректный запрос",
  "error.unknown": "Неизвестная ошибка",

  "error.connect.token_rejected": "Доступ не подтверждён: сервер не принял вашу авторизацию",
  "error.connect.method_unavailable":
    "Этим способом коннектор сейчас подключить нельзя — вопрос решается на стороне сервера",
  "error.connect.hub_unreachable": "Связаться с сервисом не удалось, ваши настройки ни при чём",
  "error.connect.unknown": "Подключение не удалось",

  "upgrade.disabled":
    "Обновление корпоративной сборки выполняется централизованно: новую версию нужно взять у распространителя сборки",
} as const

export type Key = keyof typeof ru

const en: Record<Key, string> = {
  "login.title": "Corporate SSO sign-in",
  "login.hub": "Hub",
  "login.code": "Code",
  "login.open": "Open in browser",
  "login.waiting": "Waiting for confirmation…",
  "login.copy": "copy code",
  "login.retry": "retry",
  "login.otherProvider": "other provider",
  "login.teamTitle": "Select a team",
  "login.success": "Signed in",
  "login.cancelled": "Sign-in cancelled",
  "login.needsHub": "Corporate SSO sign-in is not configured in this build",

  "connectors.title": "Connectors",
  "connectors.command": "Connector catalog",
  "connectors.loginCommand": "Corporate SSO sign-in",
  "connectors.search": "Search",
  "connectors.empty": "Catalog is empty",
  "connectors.hubDown": "Hub unavailable",
  "connectors.hubDownCached": "Hub unavailable, data from",
  "connectors.needsLogin": "Sign-in required",
  "connectors.refresh": "refresh",
  "connectors.connect": "connect",
  "connectors.reconnect": "reconnect",
  "connectors.disconnect": "disconnect",
  "connectors.permissions": "permissions",
  "connectors.openHub": "open in Hub",
  "connectors.login": "sign in",
  "connectors.authorizing": "⋯ Authorizing in browser",
  "connectors.deprecated": "deprecated",
  "connectors.stale": "data is stale, actions unavailable",
  "connectors.presetTitle": "Connector permissions",
  "connectors.permissionsUnavailable":
    "This app version does not support the connector permission model — manage permissions in the Hub",
  "connectors.permissionsUnavailableNoHub":
    "Choosing permissions for this connector is not supported by this version of the app",
  "connectors.reauth": "Re-authorization required",
  "connectors.connected": "Connected",
  "connectors.retry": "retry",
  "connectors.forget": "remove from list",
  "connectors.forgetConfirm":
    "Remove \u201c{{title}}\u201d from the list? The connector entry will be deleted from your config, and the connection on the server will be revoked if the server is configured and reachable",
  "connectors.forgetHubFailed": "Removed locally, but the Hub did not respond",
  "connectors.neverConnected": "Connection failed",
  "connectors.lost": "Connection lost",
  "connectors.disconnected": "Disconnected by you",
  "connectors.notConnectedHint": "Nothing to disconnect: there is no connection",

  "connectors.tabAll": "All",
  "connectors.tabConnected": "Connected",
  "connectors.tabNotConnected": "Not connected",
  "connectors.columnName": "Name",
  "connectors.columnType": "Type",
  "connectors.columnStatus": "Status",
  "connectors.resetFilter": "Show all",
  "empty.tabConnected": "Nothing connected yet",
  "empty.tabNotConnected": "Everything is connected",
  "empty.unparsed": "Catalog could not be parsed: every card was dropped ({{dropped}})",
  "connectors.partial": "Some catalog cards were not parsed and are hidden: {{dropped}}",

  "connectors.catalogUnavailable": "Catalog unavailable: the connector list could not be fetched",
  "connectors.facadeNeedsHub": "Connecting this connector is not configured in this build",
  "connectors.permissionsNeedHub": "Managing permissions for this connector is not configured in this build",

  "connector.back": "Back",
  "connector.owner": "Owner",
  "connector.type": "Type",
  "connector.docs": "Documentation",

  "permissions.title": "Permissions",
  "permissions.allow": "Allow",
  "permissions.ask": "Ask",
  "permissions.deny": "Deny",
  "permissions.allowAll": "Allow everything",
  "permissions.denyAll": "Deny everything",
  "permissions.mixed": "Mixed",
  "permissions.restTitle": "Other capabilities",
  "permissions.restDescription": "Connector tools that fall into none of the groups above",
  "permissions.saved": "Permissions saved",

  "status.connected": "✓ Connected",
  "status.needs_auth": "⚠ Needs auth",
  "status.not_connected": "○ Not connected",
  "status.unavailable": "✗ Unavailable",

  "preset.readonly": "read only",
  "preset.readwrite": "read and write",

  "error.corp_disabled": "Corporate mode is not configured",
  "error.hub_unavailable": "Hub unavailable",
  "error.hub_invalid_response": "Hub returned an unexpected response",
  "error.login_expired": "Sign-in session expired",
  "error.forbidden": "Access denied",
  "error.invalid_team": "Unknown team",
  "error.team_selection_not_required": "Team selection is not required",
  "error.rate_limited": "Too many attempts, try again later",
  "error.litellm_unavailable": "Key service unavailable",
  "error.litellm_invalid_response": "Key service returned an unexpected response",
  "error.unauthorized": "Sign-in required: no key found",
  "error.not_found": "Not found",
  "error.invalid_request": "Invalid request",
  "error.unknown": "Unknown error",

  "error.connect.token_rejected": "Access was not confirmed: the server rejected your authorization",
  "error.connect.method_unavailable":
    "This connector cannot be connected this way right now — it is resolved on the server side",
  "error.connect.hub_unreachable": "The service could not be reached; your settings are not at fault",
  "error.connect.unknown": "Connection failed",

  "upgrade.disabled": "Corporate builds are updated centrally: get the new version from whoever distributes the build",
}

export const dictionaries = { ru, en } as const

export function language(): "ru" | "en" {
  const explicit = process.env["OPENCODE_CORP_LANG"]?.toLowerCase()
  if (explicit === "ru" || explicit === "en") return explicit
  return corpEnabled() ? "ru" : "en"
}

export function t(key: Key): string {
  return language() === "ru" ? ru[key] : en[key]
}

/**
 * Текст с подстановками `{{имя}}` (S-I4). Форма подстановки та же, что у словарей Desktop (S-I1):
 * ключи обеих оболочек зеркальны, и расходиться их тексты не должны.
 */
export function format(key: Key, values: Record<string, string | number>): string {
  return t(key).replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

/** Текст ошибки по стабильному коду корп-роутов (S-A5); неизвестный код отдаётся как есть. */
export function errorText(code: string | undefined): string {
  if (!code) return t("error.unknown")
  const key = `error.${code}` as Key
  return key in ru ? t(key) : code
}

/**
 * Текст объяснения ошибки подключения по её классу (S-V19, S-T10).
 * Класс определяется всегда, поэтому объяснение есть у любой ошибки — включая `unknown`.
 */
export function connectErrorText(errorClass: string | undefined): string {
  const key = `error.connect.${errorClass ?? "unknown"}` as Key
  return key in ru ? t(key) : t("error.connect.unknown")
}
