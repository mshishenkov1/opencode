import { describe, expect, mock, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import * as CorpCredentials from "@/corp/credentials"
import { testEffect } from "../lib/effect"

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// Mock the transport constructors to capture their arguments
void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("Mock transport cannot connect")
    }
  },
}))

beforeEach(() => {
  transportCalls.length = 0
})

// Import MCP after mocking
const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer)

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default)", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer test-token",
            "X-Custom-Header": "custom-value",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      // Both transports should have been created with headers
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        })
        // OAuth should be enabled by default, so authProvider should exist
        expect(call.options.authProvider).toBeDefined()
      }
    }),
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-oauth", {
          type: "remote",
          url: "https://example.com/mcp",
          oauth: false,
          headers: {
            Authorization: "Bearer test-token",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // OAuth is disabled, so no authProvider
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-headers", {
          type: "remote",
          url: "https://example.com/mcp",
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        // No headers means requestInit should be undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    }),
  )
})

/**
 * Шов подстановки учётных заголовков прямого подключения (S-V26 п.4, D-60; AC-323, AC-347) — тест
 * В ТОЧКЕ ПРИМЕНЕНИЯ, а не на чистых функциях `CorpCredentials.mergeHeaders`/`requestHeaders`
 * отдельно от вызова (MAJ-1 ревью review-i4-rev113-1): транспорт создаётся настоящим вызовом
 * `mcp.add()`, и проверяется, какие заголовки реально дошли до конструктора `StreamableHTTPClientTransport`/
 * `SSEClientTransport`. Инъекция, возвращающая обе точки на `requestInit: mcp.headers` (снимающая
 * шов целиком), обязана здесь покраснеть: маркерный учётный заголовок из хранилища при ней исчезнет
 * из `requestInit`, а сырой заголовок конфига останется один.
 */
describe("mcp.headers — учётные заголовки прямого подключения подставляются в точке создания транспорта (S-V26 п.4, D-60; AC-323, AC-347)", () => {
  const dirs: string[] = []
  let previousGlobalData: string | undefined
  let previousCatalogUrl: string | undefined
  let previousHubUrl: string | undefined

  afterEach(async () => {
    if (previousGlobalData !== undefined) {
      ;(Global.Path as { data: string }).data = previousGlobalData
      previousGlobalData = undefined
    }
    if (previousCatalogUrl === undefined) delete process.env["OPENCODE_CORP_CATALOG_URL"]
    else process.env["OPENCODE_CORP_CATALOG_URL"] = previousCatalogUrl
    if (previousHubUrl === undefined) delete process.env["OPENCODE_CORP_HUB_URL"]
    else process.env["OPENCODE_CORP_HUB_URL"] = previousHubUrl
    previousCatalogUrl = undefined
    previousHubUrl = undefined
    while (dirs.length) {
      const dir = dirs.pop()!
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it.instance(
    "AC-323/AC-347: mcp.add() создаёт транспорт с учётным заголовком из хранилища вместо сырого заголовка конфига",
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "mcp-headers-seam-")))
        dirs.push(dir)
        previousGlobalData = Global.Path.data
        ;(Global.Path as { data: string }).data = dir
        previousCatalogUrl = process.env["OPENCODE_CORP_CATALOG_URL"]
        previousHubUrl = process.env["OPENCODE_CORP_HUB_URL"]
        delete process.env["OPENCODE_CORP_CATALOG_URL"]
        delete process.env["OPENCODE_CORP_HUB_URL"]

        const MARKER = "MARKER-mcp-seam-token"
        const saved = yield* Effect.promise(() =>
          CorpCredentials.save(
            "seam-server",
            {
              upstream_url: "https://example.com/mcp",
              method_id: "personal_token",
              token: MARKER,
              issued: false,
              saved_at: "2026-08-28T00:00:00.000Z",
              credential_headers: { Authorization: "Bearer {{access_token}}" },
            },
            dir,
          ),
        )
        expect(saved.ok).toBe(true)

        const mcp = yield* MCP.Service
        yield* mcp
          .add("seam-server", {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { "X-Config": "config-value" },
          })
          .pipe(Effect.catch(() => Effect.void))

        expect(transportCalls.length).toBeGreaterThanOrEqual(1)
        for (const call of transportCalls) {
          // Заголовок конфига остался (X-Config), а учётный заголовок из хранилища ПОДСТАВЛЕН —
          // не «Bearer {{access_token}}» дословно, а с реальным подставленным маркером. Инъекция,
          // возвращающая точку на `requestInit: mcp.headers`, этот Authorization не добавит вовсе.
          expect(call.options.requestInit?.headers).toEqual({
            "X-Config": "config-value",
            Authorization: `Bearer ${MARKER}`,
          })
        }
      }),
  )
})
