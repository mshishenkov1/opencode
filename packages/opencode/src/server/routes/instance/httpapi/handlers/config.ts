import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

/**
 * Тело `GET /config` — **экспортируемый именованный эффект** (корп-правка, MIN-A ревью
 * `review-i4-rev113-3`).
 *
 * Вынесено из замыкания группы ради тестового харнесса `test/fixture/corp-direct-harness.ts`:
 * настоящий `configHandlers` там смонтировать нельзя (обработчик `update` требует
 * `InstanceState.context`/`markInstanceForDisposal` и ломает вывод типов `HttpApiBuilder.group`),
 * поэтому харнесс объявлял **свою копию** обработчика `get`. Копия и продукт расходились молча:
 * сьют `credentials-leak.test.ts` проверял утечку в копии, а не в продукте. Сторож на
 * срез-сравнение исходников (`credentials-leak.test.ts`) эту слепоту закрыл, но краснеет и на
 * безобидном переформатировании тела. Экспорт снимает и слепоту, и хрупкость: харнесс монтирует
 * **эту** функцию, и весь сьют выше начинает проверять продуктовый обработчик.
 *
 * Служба берётся внутри эффекта, а не из замыкания группы, — иначе функция была бы неотделима от
 * `configHandlers` и монтировать её отдельно было бы нечего.
 */
export const configGet = Effect.fn("ConfigHttpApi.get")(function* () {
  const configSvc = yield* Config.Service
  return yield* configSvc.get()
})

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", configGet).handle("update", update).handle("providers", providers)
  }),
)
