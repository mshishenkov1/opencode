import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import * as Harness from "../../test/fixture/corp-direct-harness"

/**
 * MAJ-E (errata 1.13.6, ревью `review-i4-rev113-4`, AC-352): «экран показывает вчерашнее». Ответ
 * `permission_state` роута `PUT /corp/connectors/:alias/permissions` (ветка `{modes}`) читался из
 * того же **per-directory снимка** `configSvc.get()`, что и охранник BLK-4 (`connect-token.test.ts`):
 * значение, замерзающее на первом обращении за жизнь инстанса. Роут писал раздел `permission`
 * ДВУМЯ вызовами `configSvc.updateGlobal`, а затем считал `permission_state` по снимку, который эта
 * запись не обновляет, — экран после действия показывал состояние ДО него, а не после.
 *
 * Починка (`8101226caa`, S-V28 п.10ж): единственный источник всех пяти чтений корп-роутов —
 * `liveConfig()` = `configSvc.getGlobal()`, и ровно её TTL-кэш инвалидирует `configSvc.updateGlobal`.
 *
 * Обвязка — общий харнесс `corp-direct-harness.ts` (тот же, что у `connect-token.test.ts` и
 * `credentials-leak.test.ts`): настоящий локальный HTTP-сервер корп-роутов, `GET /config` рядом с
 * корп-группой (продуктовый `configGet`, S-Q14), MCP замокан на границе сервиса.
 */

beforeAll(async () => {
  await Harness.setupHarness()
})
beforeEach(async () => {
  await Harness.beforeEachHarness()
})
afterEach(() => {
  Harness.afterEachHarness()
})
afterAll(async () => {
  await Harness.cleanupTmpDirs()
})

/** Публикует статический каталог на сервере `target` и указывает на него сборку. */
function serveCatalog(servers: unknown[]) {
  const target = Harness.state.target
  target.routes.set("/catalog", () => Harness.json({ version: "1", servers }))
  process.env["OPENCODE_CORP_CATALOG_URL"] = `${target.url}/catalog`
}

/**
 * Карточка AC-352 (given): группа `read_posts` с инструментами `[get_post, shared_tool]`, группа
 * `write_posts` с инструментами `[shared_tool, create_post]` (в этом порядке), `rest` по умолчанию
 * `"ask"`. `shared_tool` взят НАМЕРЕННО в обе группы: он даёт ответ, которого нет в теле запроса
 * (`{read_posts:"deny", write_posts:"allow"}`), и тем отделяет вычисление от эха (then).
 */
function cardWithGroups(alias: string) {
  return {
    alias,
    title: alias,
    status: "beta",
    mode: "facade",
    mcp_url: `https://hub.example/mcp-proxy/${alias}`,
    permission_model: { kind: "consent", presets: { default: "Экран согласия" } },
    permission_groups: {
      version: 1,
      groups: [
        { id: "read_posts", title: "Чтение постов", default: "ask", tools: ["get_post", "shared_tool"] },
        { id: "write_posts", title: "Запись постов", default: "ask", tools: ["shared_tool", "create_post"] },
      ],
      rest: { default: "ask" },
    },
  }
}

/**
 * Свёртка группы НЕЗАВИСИМО от продукта (S-V23, дословно): все инструменты в одном режиме — этот
 * режим, иначе `mixed`. Тест намеренно не зовёт `CorpConnectors.permissionState` — иначе проверка
 * сверяла бы реализацию саму с собой (запрет тавтологии из роли test-agent). Ожидание выводится
 * ИЗ ФАЙЛА конфига, а не из тела запроса.
 */
function foldGroup(permission: Record<string, unknown>, keys: string[]): string {
  const modes = keys.map((key) => permission[key])
  return modes.every((mode) => mode === modes[0]) ? (modes[0] as string) : "mixed"
}

describe(
  "PUT /corp/connectors/:alias/permissions {modes} — permission_state обязан совпадать с файлом ПОСЛЕ записи (S-V21, S-V23, S-V28 п.10ж; AC-352, MAJ-E)",
  () => {
    Harness.it.live(
      "AC-352: якорь GET /config, витрина обязательна по контракту роута, PUT {modes} — read_posts:deny, write_posts:mixed (НЕ эхо allow), rest:ask",
      () =>
        Effect.gen(function* () {
          const alias = "maj-e-permission-state"
          serveCatalog([cardWithGroups(alias)])

          // Шаг 0 — ЯКОРЬ ПРЕДПОСЫЛКИ (errata 1.13.6, AC-352, given), НЕ формальность. `GET /config`
          // вызывает продуктовый `configGet`, тело которого — ровно `configSvc.get()`, МИМО корп-кода.
          // На дату этой правки корп-код `configSvc.get()` не зовёт ни в одной ветке (замер, не
          // обещание навсегда) — сторож с якорем «витрина первым действием» (`GET /corp/catalog`)
          // проверял бы побочный эффект собственной починки: витрина зовёт `liveConfig()`
          // (`getGlobal()`), а не `configSvc.get()`, и на новом появлении дефекта В ДРУГОМ МЕСТЕ
          // (не обязательно там же, где BLK-4) осталась бы ложно-зелёной. Шаг удалять нельзя.
          const anchor = yield* Harness.get(Harness.configRoute)
          expect(anchor.status).toBe(200)

          // Шаг 1 — витрина. ОБЯЗАТЕЛЬНА по контракту роута, а не только по штатному порядку: ветка
          // `{modes}` считает состав ключей по словарю групп из КЭША каталога и без предшествующего
          // чтения витрины отвечает 400 {error:"permission_groups_unavailable"} (S-V1, D-35).
          const shop = yield* Harness.get(Harness.CorpPaths.catalog)
          expect(shop.status).toBe(200)

          // Шаг 2 — запись: read_posts:"deny" явным правилом, write_posts:"allow" — но shared_tool
          // уже занят первой группой (S-V21: инструмент двух групп получает ключ по ПЕРВОЙ группе в
          // порядке каталога), поэтому write_posts расходится по инструментам и обязан стать "mixed".
          const response = yield* Harness.put(Harness.permissionsRoute(alias), {
            modes: { read_posts: "deny", write_posts: "allow" },
          })
          expect(response.status).toBe(200)
          const result = yield* Harness.body<{
            permission_state: Record<string, string>
            reauth_required: boolean
          }>(response)
          expect(result.reauth_required).toBe(false)

          // Файл — источник истины, независимо проверенный: ровно четыре ключа блока alias, ровно
          // этими значениями (S-V21, ПРАВИЛО ПОРЯДКА и ПРАВИЛО ПЕРВОЙ ГРУППЫ).
          const config = yield* Effect.promise(() => Harness.globalConfig())
          const permission: Record<string, unknown> = config.permission ?? {}
          expect(permission[`${alias}_get_post`]).toBe("deny")
          expect(permission[`${alias}_shared_tool`]).toBe("deny")
          expect(permission[`${alias}_create_post`]).toBe("allow")
          expect(permission[`${alias}_*`]).toBe("ask")

          // Ожидание свёрнуто из файла НЕЗАВИСИМОЙ функцией теста (see foldGroup), не продуктом.
          const expectedState = {
            read_posts: foldGroup(permission, [`${alias}_get_post`, `${alias}_shared_tool`]),
            write_posts: foldGroup(permission, [`${alias}_shared_tool`, `${alias}_create_post`]),
            rest: permission[`${alias}_*`] as string,
          }
          expect(expectedState).toEqual({ read_posts: "deny", write_posts: "mixed", rest: "ask" })

          // Утверждение (then): ответ роута совпадает с независимо вычисленным ожиданием из файла.
          expect(result.permission_state).toEqual(expectedState)

          // Контрольный случай (обязателен, then): "mixed" в теле запроса не встречается ни разу —
          // реализация-эхо вернула бы write_posts:"allow" (значение, присланное в modes) и сюда бы
          // не прошла. Явная проверка "не эхо", а не только "совпадает с ожиданием".
          expect(result.permission_state["write_posts"]).not.toBe("allow")
          expect(result.permission_state["write_posts"]).toBe("mixed")
        }),
    )

    /**
     * Отрицательный контроль контракта роута (S-V1, D-35): без предшествующего чтения витрины
     * ветка `{modes}` не может считать состав ключей и отвечает 400 — доказывает, что шаг 1 в
     * тесте выше не анкор, а рабочая предпосылка, которую нельзя перепутать со вспомогательным
     * действием.
     */
    Harness.it.live(
      "AC-352 (контроль контракта): без чтения витрины ветка {modes} отвечает 400 permission_groups_unavailable",
      () =>
        Effect.gen(function* () {
          const alias = "maj-e-no-shop"
          serveCatalog([cardWithGroups(alias)])

          const anchor = yield* Harness.get(Harness.configRoute)
          expect(anchor.status).toBe(200)

          // Витрина НЕ открыта — кэш каталога пуст.
          const response = yield* Harness.put(Harness.permissionsRoute(alias), {
            modes: { read_posts: "deny" },
          })
          expect(response.status).toBe(400)
          const result = yield* Harness.body<{ error: string }>(response)
          expect(result.error).toBe("permission_groups_unavailable")
        }),
    )
  },
)
