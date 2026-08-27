import {
  CorpConfigBuild,
  corpCatalogUrl,
  corpCatalogUrlIssues,
  corpEnabled,
  corpHubUrl,
  CORP_PROVIDER_ID,
  type CorpUrlIssue,
} from "@opencode-ai/core/corp/constants"

/**
 * Корпоративный слой конфигурации (S-C3) и действующий адрес модели (S-C4a).
 *
 * Слой мержится в `Config` первым — до цикла auth-записей `wellknown` (F20), поэтому его приоритет самый
 * низкий: `корп-слой < .well-known/remote-config < глобальный конфиг < OPENCODE_CONFIG < конфиг проекта`.
 */
export const CONFIG_SOURCE = "OPENCODE_CORP_CONFIG"

/** Переменная окружения, перекрывающая адрес корпоративной модели (S-C4a, D-20). */
export const MODEL_BASE_URL_ENV = "OPENCODE_CORP_MODEL_BASE_URL"

/** Текст корп-конфига или `undefined` в ванильной сборке (S-C6). */
export function configText(): string | undefined {
  const override = process.env["OPENCODE_CORP_CONFIG"]
  if (typeof override === "string" && override.trim() !== "") return override
  return CorpConfigBuild
}

/** Абсолютный адрес со схемой `http`/`https` — единственная пригодная форма адреса модели (S-C4a). */
export function isModelBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/**
 * Значение `OPENCODE_CORP_MODEL_BASE_URL` (S-C4a):
 * - `undefined` — переменная не задана, пуста или состоит из пробелов («не задано», как в S-C2);
 * - `{ url }` — пригодный адрес, подменяющий `baseURL` внутри корп-слоя;
 * - `{ invalid }` — значение не является абсолютным http/https-адресом: отбрасывается с предупреждением.
 */
export function modelBaseUrlOverride(): { url: string } | { invalid: string } | undefined {
  const raw = process.env[MODEL_BASE_URL_ENV]
  if (typeof raw !== "string") return undefined
  const value = raw.trim()
  if (value === "") return undefined
  return isModelBaseUrl(value) ? { url: value } : { invalid: value }
}

/** Текст предупреждения о непригодном значении переменной: называет и имя, и полученное значение (S-C4a). */
export function modelBaseUrlWarning(value: string): string {
  return `${MODEL_BASE_URL_ENV}: значение "${value}" не является абсолютным http/https-адресом — оно отброшено, действует адрес модели из корп-конфига`
}

/** Форма корп-слоя, интересная правилу S-C4a: провайдер корпоративной модели и его `options.baseURL`. */
type WithCorpProvider = {
  provider?: Record<string, { options?: Record<string, unknown> } | undefined>
}

/**
 * Подменяет `provider.magnit_prod.options.baseURL` **внутри корп-слоя** до слияния слоёв (S-C4a),
 * поэтому любой слой выше корп-слоя перебивает переменную окружения. Если корп-слой провайдера не
 * задаёт (ванильный или урезанный конфиг), подменять нечего — слой возвращается без изменений.
 */
export function applyModelBaseUrl<T extends WithCorpProvider>(config: T, baseURL: string): T {
  const provider = config.provider?.[CORP_PROVIDER_ID]
  if (!provider) return config
  provider.options = { ...(provider.options ?? {}), baseURL }
  return config
}

/**
 * Патч действия «Включить» (S-C11 п.4, S-C7): массив `disabled_providers` без корп-провайдера.
 *
 * `undefined` — провайдера в массиве нет, править нечего. Прочие элементы сохраняются в прежнем
 * порядке; массив, оставшийся пустым, остаётся **пустым массивом** — не удаляется и не заменяется
 * на `null`: пользователь выключал провайдеров списком, и список остаётся списком.
 *
 * Это второе и последнее исключение из S-C7 после блока `permission` (S-V21): корп-код правит
 * конфиг пользователя только по его явному действию и только в том элементе, о котором он попросил.
 */
export function enableProviderPatch(
  disabled: readonly string[] | undefined,
): { disabled_providers: string[] } | undefined {
  if (!disabled || !disabled.includes(CORP_PROVIDER_ID)) return undefined
  return { disabled_providers: disabled.filter((id) => id !== CORP_PROVIDER_ID) }
}

/** Действующий адрес модели корп-слоя: переменная окружения выше значения из корп-конфига (S-C4a). */
export function modelBaseUrlOf(config: WithCorpProvider | undefined): string | undefined {
  const value = config?.provider?.[CORP_PROVIDER_ID]?.options?.["baseURL"]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * Текст предупреждения о непригодном адресе статического каталога (S-C10 п.1).
 *
 * Называет и источник значения, и само значение — по образцу `modelBaseUrlWarning` (S-C4a):
 * «адрес отброшен» без указания, какой именно, заставляет искать его перебором.
 */
export function catalogUrlWarning(issue: CorpUrlIssue): string {
  return `${issue.name}: значение "${issue.value}" не является абсолютным http/https-адресом — оно отброшено, статический каталог не используется`
}

export { CORP_PROVIDER_ID, corpCatalogUrl, corpCatalogUrlIssues, corpEnabled, corpHubUrl }
