// ПЕРЕДАЧА TEST-АГЕНТУ (BUG-I12-002). Готовый файл теста: положить как
// packages/opencode/src/corp/login-invalidation.test.ts — импорты уже рассчитаны на эту директорию.
// Проверено обоими прогонами: до правки первый случай падает (получено undefined), после — проходит.
// Второй случай — регрессионный сторож: одного Config.invalidate() для S-A3 недостаточно.

import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { Plugin } from "@/plugin/index"
import { Provider } from "@/provider/provider"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { testEffect } from "../../test/lib/effect"

/**
 * Вход в **уже запущенном** процессе обязан дать провайдеру ключ (S-A3, S-C4b; BUG-I12-002).
 *
 * Процесс стартует без ключа (пользователь вышел) → выполняются те же шаги, что делает сервер при
 * ответе Hub `ready` (`handlePoll` в `server/routes/instance/httpapi/handlers/corp.ts`) → в том же
 * процессе спрашивается провайдер. Ключ, лежащий в auth-store, обязан быть у провайдера: иначе
 * запрос уходит в LiteLLM без заголовка `Authorization` и возвращается ошибкой
 * «AI_APICallError: Authentication Error, No api key passed in.».
 */

const CORP = ProviderV2.ID.make("magnit_prod")

const KEY = "sk-live-key"

const RECORD = {
  type: "api" as const,
  key: KEY,
  metadata: { hub: "https://hub.example", key_kind: "persistent", user_id: "u1" },
}

/** Корп-слой сборки: провайдер задан без `options.apiKey` — ключ приходит только из auth-store (S-C4b). */
const corpConfig = {
  provider: {
    magnit_prod: {
      name: "Magnit Copilot",
      npm: "@ai-sdk/openai-compatible",
      api: "https://llmlite.example.corp/v1",
      options: { baseURL: "https://llmlite.example.corp/v1" },
      models: { MagnitCopilot: { name: "MagnitCopilot" } },
    },
  },
} as any

const it = testEffect(
  Layer.mergeAll(Provider.defaultLayer, Auth.defaultLayer, Config.defaultLayer, Env.defaultLayer, Plugin.defaultLayer),
)

it.instance(
  "S-A3: после входа в живом процессе провайдер получает ключ из auth-store без перезапуска",
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    yield* auth.remove(CORP)

    // 1. Старт без ключа: пользователь вышел, запись `magnit_prod` удалена.
    const before = yield* Provider.use.list()
    expect(before[CORP]).toBeDefined()
    expect(before[CORP].key).toBeUndefined()

    // 2. Вход по SSO — ровно те шаги, что выполняет сервер при `ready`.
    yield* auth.set(CORP, RECORD)
    yield* config.invalidate()
    yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })

    // 3. Первый же запрос к модели в том же процессе.
    const after = yield* Provider.use.list()
    expect(after[CORP].key).toBe(KEY)
  }),
  { config: corpConfig },
)

it.instance(
  "регрессия BUG-I12-002: одного Config.invalidate() для этого недостаточно",
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    yield* auth.remove(CORP)

    expect((yield* Provider.use.list())[CORP].key).toBeUndefined()

    yield* auth.set(CORP, RECORD)
    yield* config.invalidate()

    // Кэш конфига провайдеров не касается: ключ читается из auth-store один раз, при построении
    // состояния инстанса. Это и есть отказ, который наблюдался в живой сборке.
    expect((yield* Provider.use.list())[CORP].key).toBeUndefined()
  }),
  { config: corpConfig },
)
