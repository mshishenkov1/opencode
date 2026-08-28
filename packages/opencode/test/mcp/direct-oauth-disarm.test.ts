import { describe, expect, mock, beforeEach } from "bun:test"
import { Effect, Exit } from "effect"
import * as CorpErrors from "@/corp/errors"
import { testEffect } from "../lib/effect"

/**
 * AC-350 (errata 1.13.4, D-63): у alias, подключённого ПРЯМЫМ способом, запись `mcp.<alias>` несёт
 * `oauth: false` (S-V25 п.6б). Это значение — не «пустое поле», а разоружение MCP-OAuth: единственное,
 * что не даёт создать OAuth-провайдера (`mcp/index.ts:229`), и то же значение прекращает действие
 * upstream-роута `POST /mcp/<alias>/auth/authenticate`: `MCP.startAuth` (`mcp/index.ts:764`) бросает
 * на `mcpConfig.oauth === false` ДО единого исходящего запроса.
 *
 * Этот файл — не `src/corp/`: проверяемое поведение целиком принадлежит upstream-коду
 * (`packages/opencode/src/mcp/index.ts`), которого форк НЕ патчит (граница S-V28 п.5, corp/patches.md).
 * Корп-правило вправе требовать только то, что оно само пишет (`oauth: false`, проверено в
 * `src/corp/connect-token.test.ts`, AC-320/AC-350(1)), а не форму ответа чужого роута — поэтому здесь
 * конкретный код/тело ответа НЕ проверяются нигде, только наблюдаемое поведение (запрос отправлен —
 * действие не выполнено; исходящих запросов нет). Тот же файл использует ровно приём
 * `test/mcp/headers.test.ts` (реальный `MCP.Service`, транспорты SDK замоканы на границе процесса —
 * `journal`, а не сеть), а не мок `MCP.Service` целиком, как делает `corp-direct-harness.ts`: здесь
 * проверяется САМА гвардия upstream, а не то, что корп-роут её не обходит.
 */

// Тот же приём, что в headers.test.ts: транспорты SDK подменяются на границе процесса, чтобы ни один
// тест не делал реальных сетевых запросов, и чтобы количество попыток создать транспорт было наблюдаемо.
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  authProvider: unknown
}> = []

/** Что должен сделать очередной сконструированный транспорт при `.start()` — переключается по тесту. */
let onStart: () => Promise<void> = async () => {
  throw new Error("onStart not configured for this test")
}

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(url: URL, options?: { authProvider?: unknown }) {
      transportCalls.push({ type: "streamable", url: url.toString(), authProvider: options?.authProvider })
    }
    async start() {
      return onStart()
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown }) {
      transportCalls.push({ type: "sse", url: url.toString(), authProvider: options?.authProvider })
    }
    async start() {
      return onStart()
    }
  },
}))

beforeEach(() => {
  transportCalls.length = 0
  onStart = async () => {
    throw new Error("onStart not configured for this test")
  }
})

// Импорт ПОСЛЕ мока модулей (как в headers.test.ts) — иначе SDK-транспорты в mcp/index.ts свяжутся
// с настоящими классами до подмены.
const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer)

const ALIAS = "direct-oauth-disarm"
const directConnectConfig = {
  type: "remote" as const,
  url: "https://target.example/mcp",
  enabled: true,
  oauth: false as const,
}

describe("AC-350: прямое подключение (oauth:false) обезвреживает upstream MCP-OAuth (D-63, S-V25 п.6б, S-V28 п.5)", () => {
  it.instance(
    "AC-350 (2): POST /mcp/<alias>/auth/authenticate мимо интерфейса — MCP.startAuth падает на oauth:false ДО единого исходящего запроса, браузер не открыт",
    () =>
      Effect.gen(function* () {
        // Запись `mcp.<alias>` заводится настоящим вызовом `mcp.add()` — тем же способом, что и
        // предыдущий шов `test/mcp/headers.test.ts` — а НЕ через опцию `config` у `it.instance`:
        // предзаполненный проектный конфиг заставляет обвязку инстанса САМОЙ подключить перечисленные
        // серверы при старте (фоновый вызов `add()`, гоняющийся с телом теста), из-за чего
        // `transportCalls` уже не пуст к моменту первой проверки безотносительно охранника
        // `MCP.startAuth`. `add()` здесь — `yield*`-ится (не фоновая задача), поэтому к моменту
        // следующей строки его попытка подключения гарантированно завершена.
        const mcp = yield* MCP.Service
        yield* mcp.add(ALIAS, directConnectConfig).pipe(Effect.catch(() => Effect.void))
        transportCalls.length = 0

        const exit = yield* mcp.authenticate(ALIAS).pipe(Effect.exit)

        // Конкретный код/тело ответа не проверяется (S-V28 п.5, граница патчей форка) — проверяется
        // только то, что действие НЕ ВЫПОЛНЕНО: отказ произошёл, и ни один НОВЫЙ транспорт не создан
        // (счётчик обнулён строкой выше — после того, как обычное подключение через `add()` уже
        // случилось и не в счёт).
        expect(Exit.isFailure(exit)).toBe(true)

        // Ни StreamableHTTP, ни SSE не сконструированы — значит ни discovery
        // (/.well-known/oauth-authorization-server, /.well-known/openid-configuration), ни DCR, ни
        // authorize, ни token не были отправлены: guard `mcpConfig.oauth === false` (mcp/index.ts:764)
        // срабатывает раньше единственной строки, которая создаёт транспорт.
        expect(transportCalls).toEqual([])
      }),
  )

  it.instance(
    "AC-350 (3): целевая система отвечает 401 на запрос MCP — соединение не поднимается, класс token_rejected по S-V19, ни одного OAuth-запроса",
    () =>
      Effect.gen(function* () {
        // Без authProvider (oauth:false) SDK не перехватывает 401 в UnauthorizedError и не запускает
        // OAuth-поток — целевая система отвечает обычным HTTP-отказом, и он доходит до вызывающего
        // кода как есть. Симуляция ровно этого: транспорт получает обычную (не UnauthorizedError)
        // ошибку с текстом ответа целевой системы.
        onStart = async () => {
          throw new Error("Unauthorized: target responded 401")
        }

        const mcp = yield* MCP.Service
        yield* mcp.add(ALIAS, directConnectConfig).pipe(Effect.catch(() => Effect.void))

        const statuses = yield* mcp.status()
        const status = statuses[ALIAS]
        expect(status?.status).toBe("failed")

        // Оба зонда транспорта (StreamableHTTP, SSE) обязаны остаться БЕЗ authProvider — это и есть
        // «нет ни одного OAuth-запроса»: с authProvider транспорт при 401 бросил бы UnauthorizedError
        // и код свернул бы в needs_auth/needs_client_registration, а не в token_rejected (D-63,
        // connectors.ts: «вооружённый провайдер на 401 запускал OAuth-поток транспорта»).
        expect(transportCalls.length).toBeGreaterThan(0)
        for (const call of transportCalls) expect(call.authProvider).toBeUndefined()

        // S-V19: класс ошибки, который увидит карточка (`CorpErrors.connectErrorClass`, тот же вызов,
        // что `corp/status.ts`), — token_rejected, и предлагаемое действие «Ввести токен заново».
        const errorClass = CorpErrors.connectErrorClass({
          local: status?.status,
          ...(status && "error" in status && status.error !== undefined ? { message: status.error } : {}),
        })
        expect(errorClass).toBe("token_rejected")
      }),
  )
})
