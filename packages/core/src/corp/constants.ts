/**
 * Корпоративный слой: build-константы (S-C2, S-C5).
 *
 * Константы подставляются бандлером (`define` в `packages/opencode/script/build.ts`) по образцу
 * `OPENCODE_VERSION` (F25). В dev-режиме и в ванильной сборке они не определены — тогда корпоративные
 * возможности выключены целиком (S-C5/S-C6) и поведение бинарника совпадает с upstream.
 */

declare global {
  const OPENCODE_CORP_HUB_URL: string
  const OPENCODE_CORP_CONFIG: string
  const OPENCODE_CORP_CLI_UPDATE_URL: string
  const OPENCODE_CORP_CATALOG_URL: string
}

function present(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Идентификатор провайдера корпоративной модели; он же ключ записи в auth-store (D-3). */
export const CORP_PROVIDER_ID = "magnit_prod"

/** Нормализация адреса Hub: пустое значение → `undefined`, хвостовые `/` отбрасываются (S-C2). */
export function normalizeHubUrl(value: string | undefined): string | undefined {
  const trimmed = present(value)
  return trimmed === undefined ? undefined : trimmed.replace(/\/+$/, "")
}

/** Адрес Hub из build-константы. */
export const CorpHubUrlBuild = normalizeHubUrl(
  typeof OPENCODE_CORP_HUB_URL === "string" ? OPENCODE_CORP_HUB_URL : undefined,
)

/** JSON корпоративного конфига из build-константы (сырой текст, разбирается слоем конфига, S-C3). */
export const CorpConfigBuild = present(typeof OPENCODE_CORP_CONFIG === "string" ? OPENCODE_CORP_CONFIG : undefined)

/**
 * Действующий адрес Hub (S-C5), в порядке убывания приоритета:
 * 1) `override` — флаг `--hub` команд `opencode corp *`;
 * 2) переменная окружения `OPENCODE_CORP_HUB_URL`;
 * 3) build-константа `OPENCODE_CORP_HUB_URL`.
 */
export function corpHubUrl(override?: string): string | undefined {
  return normalizeHubUrl(override) ?? normalizeHubUrl(process.env["OPENCODE_CORP_HUB_URL"]) ?? CorpHubUrlBuild
}

/**
 * Адрес внутреннего источника обновлений CLI из build-константы (S-B14, D-34).
 *
 * Имя и обработка — по образцу `CORP_HUB_URL` и `CORP_DESKTOP_UPDATE_URL`: хвостовые `/` обрезаются,
 * пустое значение означает «адрес не задан». Значение не задано — `opencode upgrade` не делает ни
 * одного сетевого запроса и говорит, что обновление выполняется централизованно.
 */
export const CorpCliUpdateUrlBuild = normalizeHubUrl(
  typeof OPENCODE_CORP_CLI_UPDATE_URL === "string" ? OPENCODE_CORP_CLI_UPDATE_URL : undefined,
)

/**
 * Действующий адрес источника обновлений CLI (S-B14): переменная окружения выше build-константы —
 * тот же порядок, что у адреса Hub (S-C5).
 */
export function corpCliUpdateUrl(): string | undefined {
  return normalizeHubUrl(process.env["OPENCODE_CORP_CLI_UPDATE_URL"]) ?? CorpCliUpdateUrlBuild
}

/** Имя переменной окружения и build-константы адреса статического каталога (S-C10 п.1). */
export const CORP_CATALOG_URL_ENV = "OPENCODE_CORP_CATALOG_URL"

/**
 * Абсолютный адрес со схемой `http`/`https` — единственная пригодная форма адреса каталога (S-C10 п.1).
 * Тот же принцип, что у адреса модели (S-C4a): непригодное значение отбрасывается, а не роняет загрузку.
 */
function absoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Нормализация адреса статического каталога (S-C10 п.1): та же, что у адреса Hub (trim, пустая
 * строка — «не задано», хвостовые `/` отбрасываются), плюс проверка схемы. Значение, не являющееся
 * абсолютным http/https-адресом, трактуется как незаданное — о нём сообщает `corpCatalogUrlIssues`.
 */
export function normalizeCatalogUrl(value: string | undefined): string | undefined {
  const trimmed = normalizeHubUrl(value)
  if (trimmed === undefined) return undefined
  return absoluteHttpUrl(trimmed) ? trimmed : undefined
}

/** Адрес статического каталога из build-константы (S-C10 п.1). */
export const CorpCatalogUrlBuild = normalizeCatalogUrl(
  typeof OPENCODE_CORP_CATALOG_URL === "string" ? OPENCODE_CORP_CATALOG_URL : undefined,
)

/**
 * Действующий адрес статического каталога (S-C10 п.1), в порядке убывания приоритета:
 * 1) переменная окружения `OPENCODE_CORP_CATALOG_URL` процесса;
 * 2) build-константа `OPENCODE_CORP_CATALOG_URL`.
 *
 * Флага командной строки для адреса каталога нет: `--hub` относится только к адресу Hub (S-C5).
 */
export function corpCatalogUrl(): string | undefined {
  return normalizeCatalogUrl(process.env[CORP_CATALOG_URL_ENV]) ?? CorpCatalogUrlBuild
}

/** Отброшенное значение адреса каталога: имя источника и то, что в нём лежало (S-C10 п.1). */
export interface CorpUrlIssue {
  name: string
  value: string
}

/**
 * Непригодные значения адреса каталога — по одному на источник (S-C10 п.1).
 *
 * Логированием занимается вызывающий (слой конфига), как и у S-C4a: сюда ввод-вывод не заводится,
 * чтобы модуль оставался пригодным и для UI-пакетов.
 */
export function corpCatalogUrlIssues(): CorpUrlIssue[] {
  const issues: CorpUrlIssue[] = []
  const seen: [string, string | undefined][] = [
    [CORP_CATALOG_URL_ENV, process.env[CORP_CATALOG_URL_ENV]],
    [
      `build-константа ${CORP_CATALOG_URL_ENV}`,
      typeof OPENCODE_CORP_CATALOG_URL === "string" ? OPENCODE_CORP_CATALOG_URL : undefined,
    ],
  ]
  for (const [name, raw] of seen) {
    const trimmed = normalizeHubUrl(raw)
    if (trimmed !== undefined && !absoluteHttpUrl(trimmed)) issues.push({ name, value: trimmed })
  }
  return issues
}

/**
 * Корпоративные возможности включены, если известен адрес Hub **или** адрес каталога
 * (S-C5, S-C10 п.2, D-40).
 *
 * Каталог не требует ни ключа, ни сессии, ни аудита, поэтому он не свойство Hub: сборка без Hub, но
 * с адресом каталога остаётся корпоративной. Решение принимается здесь и только здесь — второй копии
 * проверки не заводится.
 */
export function corpEnabled(override?: string): boolean {
  return corpHubUrl(override) !== undefined || corpCatalogUrl() !== undefined
}

/**
 * Подпись пользователя для показа человеку (S-A13, D-19).
 *
 * Email может быть неизвестен: корпоративный LiteLLM его не возвращает, и Hub присылает поле
 * отсутствующим или `null`. В этом случае пользователь показывается по `user_id` — единственному
 * обязательному идентификатору. Пустая подстановка, «null» и «undefined» на экране запрещены,
 * поэтому пустая строка приравнивается к неизвестному email.
 */
export function corpUserEmail(user: { email?: string | null }): string | undefined {
  const email = typeof user.email === "string" ? user.email.trim() : ""
  return email === "" ? undefined : email
}

/** Значение подписи: email, а при неизвестном email — `user_id` (S-A13). */
export function corpUserLabel(user: { user_id: string; email?: string | null }): string {
  return corpUserEmail(user) ?? user.user_id
}

/**
 * Значение колонки «Тип», когда каталог его не назвал (S-V22, решение заказчика от 30.08).
 *
 * Не переводится и в словари не попадает: `MCP` — имя протокола, а не слово языка.
 */
export const CONNECTOR_TYPE_DEFAULT = "MCP"

/**
 * Значение колонки «Тип» (S-V22, решение заказчика от 30.08): `type` → при его отсутствии или
 * пустоте `MCP`.
 *
 * Прежняя деградация `type` → `owner` → пустая ячейка **отменена**. Имя владельца — другой факт, и в
 * колонке типа оно неверно: колонка отвечает на «что это за коннектор», а не «чей он». Все
 * коннекторы каталога одной природы — MCP-серверы, — поэтому умолчание называет её прямо, а
 * различает коннекторы бейдж способа подключения рядом. Владелец при этом никуда не делся: он
 * показывается своей строкой на странице коннектора.
 *
 * Правило одно на обе оболочки — как `CorpStatus.compute` (S-Q9): TUI и Desktop берут значение
 * отсюда и сами его не выводят, поэтому разойтись не могут.
 */
export function connectorType(card: { type?: string }): string {
  const type = card.type?.trim()
  return type ? type : CONNECTOR_TYPE_DEFAULT
}

/**
 * Монограмма коннектора (S-V22, ревизия 1.14) — то, что витрина рисует вместо картинки, когда
 * `icon` каталогом не прислан.
 *
 * Правило читается вслух и проверено на макете заказчика:
 *
 * 1. короткое слово из заглавных букв — аббревиатура, и она остаётся собой целиком («ТЭГ» → ТЭГ);
 * 2. иначе — первые две заглавные буквы названия, откуда бы они ни были: из разных слов
 *    («Mattermost Dev» → MD) или из середины одного («GitLab Платформа» → GL);
 * 3. заглавных меньше двух — первая буква названия («Confluence» → C).
 *
 * Второе правило берёт заглавные, а не «первые буквы слов»: у «GitLab Платформа» это дало бы
 * латиницу и кириллицу рядом («GП»), что не читается ни как слово, ни как сокращение.
 *
 * Пустое название монограммы не даёт: подложка тогда пустая, а не с выдуманной буквой.
 */
export function connectorMonogram(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return ""
  const upper = (value: string) => value === value.toUpperCase() && value !== value.toLowerCase()
  if (trimmed.length <= 3 && !/\s/.test(trimmed) && upper(trimmed)) return trimmed
  const capitals = [...trimmed].filter(upper)
  if (capitals.length >= 2) return capitals.slice(0, 2).join("")
  return trimmed.slice(0, 1).toUpperCase()
}
