import { CorpConfigBuild, corpEnabled, corpHubUrl, CORP_PROVIDER_ID } from "@opencode-ai/core/corp/constants"

/**
 * Корпоративный слой конфигурации (S-C3).
 *
 * Слой мержится в `Config` первым — до цикла auth-записей `wellknown` (F20), поэтому его приоритет самый
 * низкий: `корп-слой < .well-known/remote-config < глобальный конфиг < OPENCODE_CONFIG < конфиг проекта`.
 */
export const CONFIG_SOURCE = "OPENCODE_CORP_CONFIG"

/** Текст корп-конфига или `undefined` в ванильной сборке (S-C6). */
export function configText(): string | undefined {
  const override = process.env["OPENCODE_CORP_CONFIG"]
  if (typeof override === "string" && override.trim() !== "") return override
  return CorpConfigBuild
}

export { CORP_PROVIDER_ID, corpEnabled, corpHubUrl }
