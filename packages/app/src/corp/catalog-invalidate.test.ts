import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Сторож на клиентскую половину «витрина после входа — устаревший ответ каталога больше не
 * переживает действие» (`d2f4243176`) — до этого файла коммит не имел ни одного файла тестов.
 *
 * Механизм — `packages/app/src/context/corp.ts`: `useCorpCatalog`/`useCorpStatus` получают
 * `staleTime`+`refetchOnMount:true`, а `useCorpInvalidate` НЕ помечает неактивные ответы устаревшими,
 * а УДАЛЯЕТ их (`client.removeQueries`) — у них нет читателя, которому важен переход, зато есть
 * тело, снятое ДО действия.
 *
 * Ловушка, описанная в задаче: на чистом клиенте `refetchOnMount` глобально **выключен**
 * (`false` — `app.tsx`, `QueryProvider`), и дефект становится невидим, если тест сам включит его
 * на уровне `QueryClient`. Поэтому здесь `QueryClient` строится с РЕАЛЬНЫМИ умолчаниями
 * приложения — они не переписаны руками, а взяты из настоящего `app.tsx` (см. `appQueryDefaults()`
 * ниже) и проверены на равенство `{refetchOnReconnect:false, refetchOnMount:false,
 * refetchOnWindowFocus:false}` как якорь-предпосылка (если приложение когда-нибудь поменяет
 * умолчание, этот тест покраснеет вместе с ним, а не тихо потеряет смысл).
 *
 * `useCorpCatalog`/`useCorpInvalidate` — solid-query хуки с зависимостью от `useServerSDK`
 * (`ServerSDK` контекста, живого сервера, EventBus) — поднимать их через реальный JSX/DOM-рендер
 * здесь не на чем: в `packages/app` нет ни одного `*.test.tsx`, `bun test` резолвит `solid-js` в
 * серверную (SSR) сборку без `--conditions=browser`, а `test:unit` (команда, которой прогоняется
 * этот файл) этот флаг не передаёт. Поэтому, тем же приёмом, что `revoke-toast.test.ts` и
 * `connectors-view.test.ts::viewFunction`, тело функций берётся ИЗ РЕАЛЬНОГО ИСХОДНИКА (не
 * копируется руками) и исполняется — но не через `new Function` на сыром TS (в теле есть
 * TS-аннотации: `queryKey: readonly unknown[]`), а через `Bun.Transpiler` (снимает только типы,
 * не логику) и затем `new Function`. `useServerSDK`/`useQuery`/`useQueryClient` подставляются как
 * параметры — тот же класс подмены, что мок MCP на границе сервиса в `orchestration.test.ts`.
 *
 * Наблюдаемое поведение проверяется настоящей `@tanstack/query-core` машинерией
 * (`QueryClient`/`QueryObserver`, реэкспортированы из `@tanstack/solid-query` — это framework-agnostic
 * классы, использующие `solid-js` не более, чем сам файл), а не пересказом решения.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/catalog-invalidate.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const CORP_SOURCE = fs.readFileSync(path.join(APP, "context/corp.ts"), "utf8")
const APP_TSX_SOURCE = fs.readFileSync(path.join(APP, "app.tsx"), "utf8")

/** Текст объявления функции целиком (сигнатура + тело) — от маркера до парной закрывающей `}`. */
function functionSource(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const parenStart = source.indexOf("(", at)
  let parenDepth = 0
  let parenEnd = -1
  for (let index = parenStart; index < source.length; index++) {
    if (source[index] === "(") parenDepth += 1
    else if (source[index] === ")") {
      parenDepth -= 1
      if (parenDepth === 0) {
        parenEnd = index
        break
      }
    }
  }
  expect(parenEnd, `не закрыт список параметров ${marker}`).toBeGreaterThan(-1)
  const bodyStart = source.indexOf("{", parenEnd)
  let braceDepth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") braceDepth += 1
    else if (source[index] === "}") {
      braceDepth -= 1
      if (braceDepth === 0) return source.slice(at, index + 1)
    }
  }
  throw new Error(`тело ${marker} не закрыто`)
}

/** TS -> JS (только типы снимаются, поведение — нет) + запрет module-level `export` внутри Function body. */
function toPlainFunction(tsSource: string): string {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  return transpiler.transformSync(tsSource).replace(/^export\s+/m, "")
}

/**
 * Реальные умолчания `QueryClient` приложения (S-V28 п.10ж) — якорь-предпосылка: если это когда-нибудь
 * перестанет быть `{refetchOnReconnect:false, refetchOnMount:false, refetchOnWindowFocus:false}`,
 * тест ниже обязан покраснеть вместе с этим фактом, а не молча продолжать проверять устаревшее
 * умолчание.
 */
function appQueryDefaults(): { refetchOnReconnect: boolean; refetchOnMount: boolean; refetchOnWindowFocus: boolean } {
  const marker = "function QueryProvider(props: ParentProps) {"
  const at = APP_TSX_SOURCE.indexOf(marker)
  expect(at, "не найдено QueryProvider в app.tsx").toBeGreaterThan(-1)
  const queriesAt = APP_TSX_SOURCE.indexOf("queries: {", at)
  expect(queriesAt, "не найден блок queries: {...} в QueryProvider").toBeGreaterThan(-1)
  const blockStart = queriesAt + "queries: {".length
  const blockEnd = APP_TSX_SOURCE.indexOf("}", blockStart)
  const block = APP_TSX_SOURCE.slice(blockStart, blockEnd)
  return new Function(`"use strict"; return {${block}}`)()
}

describe("app.tsx — умолчание QueryClient (предпосылка, без которой сторож ниже теряет смысл)", () => {
  test("refetchOnMount выключен ГЛОБАЛЬНО — именно из-за этого умолчания дефект d2f4243176 был невидим", () => {
    expect(appQueryDefaults()).toEqual({
      refetchOnReconnect: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
    })
  })
})

/**
 * Реальные `staleTime`/`refetchOnMount`/`retry` из `useCorpCatalog` — не переписаны руками.
 *
 * `refetchOnMount` включается в результат ТОЛЬКО если ключ реально присутствует в захваченном
 * объекте опций: `QueryObserver` мёржит опции с умолчаниями клиента, и явное значение `undefined`
 * у ключа — это НЕ то же самое, что отсутствие ключа (первое может перебить умолчание клиента
 * значением `undefined`, второе корректно наследует умолчание). Если строка `refetchOnMount: true`
 * когда-нибудь пропадёт из `useCorpCatalog`, это обязано вернуть сюда «ключа нет» — ровно то
 * состояние, которое и воспроизводит регрессию.
 */
function realCorpCatalogOptions(): { staleTime: number; retry: boolean; refetchOnMount?: boolean } {
  const js = toPlainFunction(functionSource(CORP_SOURCE, "export function useCorpCatalog("))
  const factory = new Function("useServerSDK", "useQuery", `${js}\nreturn useCorpCatalog;`)
  let captured: any
  const fakeUseQuery = (optionsFn: () => unknown) => {
    captured = optionsFn()
    return {}
  }
  const fakeUseServerSDK = () => () => ({
    scope: "local",
    client: { corp: { catalog: async () => ({ data: { servers: [] } }) } },
  })
  const useCorpCatalogReal = factory(fakeUseServerSDK, fakeUseQuery)
  useCorpCatalogReal(() => true)
  expect(captured, "useCorpCatalog не вызвал useQuery").toBeDefined()
  return {
    staleTime: captured.staleTime,
    retry: captured.retry,
    ...("refetchOnMount" in captured ? { refetchOnMount: captured.refetchOnMount } : {}),
  }
}

/** Реальный `useCorpInvalidate()` — исполняется на НАСТОЯЩЕМ `QueryClient` (query-core), не на моке. */
function realCorpInvalidate(client: unknown, scope: string) {
  const js = toPlainFunction(functionSource(CORP_SOURCE, "export function useCorpInvalidate("))
  const factory = new Function("useServerSDK", "useQueryClient", `${js}\nreturn useCorpInvalidate;`)
  const fakeUseServerSDK = () => () => ({ scope })
  const fakeUseQueryClient = () => client
  const useCorpInvalidateReal = factory(fakeUseServerSDK, fakeUseQueryClient)
  return useCorpInvalidateReal() as () => Promise<void>
}

describe("useCorpInvalidate — устаревший ответ каталога не переживает действие (d2f4243176)", () => {
  test("НЕАКТИВНЫЙ corp.catalog (нет подписчика) УДАЛЯЕТСЯ инвалидацией, а не просто помечается устаревшим", async () => {
    const { QueryClient } = await import("@tanstack/solid-query")
    const qc = new QueryClient({ defaultOptions: { queries: appQueryDefaults() } })
    const key = ["local", "corp.catalog"] as const

    // Экран каталога был открыт, показал «Требуется вход» (S-V12: hub_error приходит успешным
    // ответом 200 и ложится в кэш как валидные данные), затем закрыт (S-D...: экран входа
    // открывается `dialog.show`, витрина уничтожается) — подписчика на этот момент уже нет.
    qc.setQueryData(key, { hub_error: "unauthorized", servers: [] })
    expect(qc.getQueryData(key)).toBeDefined()

    const invalidate = realCorpInvalidate(qc, "local")
    await invalidate()

    // Снят целиком — не оставлен «помеченным устаревшим» со старым телом внутри.
    expect(qc.getQueryData(key)).toBeUndefined()
  })

  test("АКТИВНЫЙ corp.status инвалидацией не удаляется — удаление адресовано только неактивным ответам", async () => {
    const { QueryClient, QueryObserver } = await import("@tanstack/solid-query")
    const qc = new QueryClient({ defaultOptions: { queries: appQueryDefaults() } })
    const key = ["local", "corp.status"] as const
    qc.setQueryData(key, { enabled: true, authenticated: false })

    // Подписчик есть — тот самый «активный запрос», который в комментарии `useCorpInvalidate`
    // назван Layout/Home.
    const observer = new QueryObserver(qc, { queryKey: key, queryFn: async () => ({ enabled: true, authenticated: true }) })
    const unsubscribe = observer.subscribe(() => {})

    const invalidate = realCorpInvalidate(qc, "local")
    await invalidate()

    // Активный подписчик получил обновление ЧЕРЕЗ обычную инвалидацию (перезапрос), а не остался
    // без записи в кэше вовсе.
    // (Через промежуточную переменную: `expect(qc.getQueryData(key))` инлайном сталкивает вывод типов
    // `getQueryData` с перегрузками `expect`, и tsgo ошибочно схлопывает результат до `undefined` —
    // TS2769. Присваивание разрывает эту цепочку вывода, поведение проверки не меняется.)
    const activeStatus = qc.getQueryData(key)
    expect(activeStatus).toEqual({ enabled: true, authenticated: true })
    unsubscribe()
  })
})

describe("после входа витрина не показывает «Требуется вход» при вошедшем пользователе (d2f4243176)", () => {
  test("повторное открытие corp.catalog после useCorpInvalidate() делает НАСТОЯЩИЙ запрос и показывает свежий каталог", async () => {
    const { QueryClient, QueryObserver } = await import("@tanstack/solid-query")
    const qc = new QueryClient({ defaultOptions: { queries: appQueryDefaults() } })
    const options = realCorpCatalogOptions()
    const key = ["local", "corp.catalog"] as const

    // 1. Первое открытие — Hub говорит «unauthorized» (S-V12), экран закрывается.
    let firstCalls = 0
    const observer1 = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async () => {
        firstCalls += 1
        return { hub_error: "unauthorized", servers: [] }
      },
      ...options,
    })
    const unsubscribe1 = observer1.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((observer1.getCurrentResult().data as any)?.hub_error).toBe("unauthorized")
    unsubscribe1()

    // 2. Вход — витрина уничтожена в этот момент (экран входа), useCorpInvalidate() действует на
    // неактивный запрос.
    await realCorpInvalidate(qc, "local")()
    expect(qc.getQueryData(key)).toBeUndefined()

    // 3. Повторное открытие — НОВЫЙ observer с РЕАЛЬНЫМИ опциями useCorpCatalog. Hub теперь
    // отвечает настоящим каталогом вошедшего пользователя.
    let secondCalls = 0
    const observer2 = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async () => {
        secondCalls += 1
        return { servers: [{ alias: "srv-a" }] }
      },
      ...options,
    })
    const unsubscribe2 = observer2.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 30))
    unsubscribe2()

    // Реальный запрос ушёл — не тишина из-за глобального refetchOnMount:false клиента приложения.
    expect(secondCalls).toBe(1)
    const result = observer2.getCurrentResult().data as any
    expect(result?.hub_error).toBeUndefined()
    expect(result?.servers).toEqual([{ alias: "srv-a" }])
  })

  test("refetchOnMount:true у useCorpCatalog обязателен: ДАННЫЕ ЕСТЬ (помечены устаревшими, не удалены) — без переопределения глобальное refetchOnMount:false клиента не даёт перезапросить", async () => {
    const { QueryClient, QueryObserver } = await import("@tanstack/solid-query")
    const qc = new QueryClient({ defaultOptions: { queries: appQueryDefaults() } })
    const options = realCorpCatalogOptions()
    const key = ["local", "corp.catalog"] as const

    // Данные ЕСТЬ (не удалены) и помечены invalidated — ветка, где именно refetchOnMount решает
    // исход (data===undefined форсировал бы запрос в любом случае, независимо от refetchOnMount).
    qc.setQueryData(key, { hub_error: "unauthorized", servers: [] })
    qc.invalidateQueries({ queryKey: key, refetchType: "none" })

    let calls = 0
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async () => {
        calls += 1
        return { servers: [{ alias: "srv-b" }] }
      },
      ...options,
    })
    const unsubscribe = observer.subscribe(() => {})
    await new Promise((resolve) => setTimeout(resolve, 30))
    unsubscribe()

    expect(calls).toBe(1)
    expect((observer.getCurrentResult().data as any)?.hub_error).toBeUndefined()
  })
})
