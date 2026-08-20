import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { Env } from "@/env"
import { Filesystem } from "@/util/filesystem"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AccountTest } from "../../test/fake/account"
import { NpmTest } from "../../test/fake/npm"
import { provideInstanceEffect, TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../../test/fixture/fixture"
import { testEffect } from "../../test/lib/effect"
import * as CorpConfig from "./config"
import * as CorpConnectors from "./connectors"

/**
 * Корпоративный слой конфигурации, действующий адрес Hub и действующий адрес модели
 * (S-C2…S-C7, S-C4a, S-C4b, S-Q6; AC-01, AC-04, AC-05, AC-06, AC-07, AC-08, AC-11, AC-118,
 * AC-132, AC-133).
 *
 * Приоритет build-константы проверяется в отдельном процессе: она подставляется бандлером как
 * глобальная переменная и в dev-режиме не определена (S-C6).
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const CONSTANTS = path.join(ROOT, "packages/core/src/corp/constants.ts")

/** Умолчание адреса корпоративной модели из корп-конфига (S-C4a). */
const CORP_MODEL_BASE_URL = "https://llmlite.ailab-copilot-prod.corp.tander.ru/v1"
/** Имя переменной окружения, перекрывающей адрес модели внутри корп-слоя (S-C4a, D-20). */
const MODEL_BASE_URL_ENV = "OPENCODE_CORP_MODEL_BASE_URL"

// --- Действующий адрес Hub (S-C5) ---

async function probe(input: { build?: string; env?: string; flag?: string }) {
  const script = [
    input.build === undefined ? "" : `globalThis.OPENCODE_CORP_HUB_URL = ${JSON.stringify(input.build)};`,
    `const m = await import(${JSON.stringify(CONSTANTS)});`,
    `const flag = ${input.flag === undefined ? "undefined" : JSON.stringify(input.flag)};`,
    `console.log(JSON.stringify({ build: m.CorpHubUrlBuild ?? null, effective: m.corpHubUrl(flag) ?? null, enabled: m.corpEnabled(flag) }));`,
  ].join("\n")
  const env = { ...process.env }
  delete env["OPENCODE_CORP_HUB_URL"]
  if (input.env !== undefined) env["OPENCODE_CORP_HUB_URL"] = input.env
  const proc = Bun.spawn({ cmd: ["bun", "-e", script], cwd: ROOT, env, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`подпроцесс упал: ${err}`)
  return JSON.parse(out.trim().split("\n").pop()!) as {
    build: string | null
    effective: string | null
    enabled: boolean
  }
}

describe("corp — действующий адрес Hub (AC-04, AC-08)", () => {
  test("AC-08: переменная окружения перекрывает build-константу", async () => {
    const result = await probe({ build: "https://build.test", env: "https://env.test" })
    expect(result.build).toBe("https://build.test")
    expect(result.effective).toBe("https://env.test")
    expect(result.enabled).toBe(true)
  }, 60_000)

  test("AC-08: флаг --hub перекрывает и переменную окружения, и build-константу", async () => {
    const result = await probe({ build: "https://build.test", env: "https://env.test", flag: "https://flag.test" })
    expect(result.effective).toBe("https://flag.test")
  }, 60_000)

  test("AC-08: без переменной окружения действует build-константа", async () => {
    const result = await probe({ build: "https://build.test/" })
    expect(result.effective).toBe("https://build.test")
  }, 60_000)

  test("AC-04: без константы и переменной окружения корп-функции выключены", async () => {
    const result = await probe({})
    expect(result.build).toBeNull()
    expect(result.effective).toBeNull()
    expect(result.enabled).toBe(false)
  }, 60_000)

  test("AC-04: в dev-режиме корп-конфиг из build-константы отсутствует", () => {
    const previous = process.env["OPENCODE_CORP_CONFIG"]
    delete process.env["OPENCODE_CORP_CONFIG"]
    try {
      expect(CorpConfig.configText()).toBeUndefined()
      expect(CorpConfig.corpHubUrl()).toBeUndefined()
      expect(CorpConfig.corpEnabled()).toBe(false)
    } finally {
      if (previous !== undefined) process.env["OPENCODE_CORP_CONFIG"] = previous
    }
  })

  test("AC-08: переменная окружения OPENCODE_CORP_CONFIG перекрывает build-константу", () => {
    const previous = process.env["OPENCODE_CORP_CONFIG"]
    process.env["OPENCODE_CORP_CONFIG"] = '{"autoupdate":false}'
    try {
      expect(CorpConfig.configText()).toBe('{"autoupdate":false}')
    } finally {
      if (previous === undefined) delete process.env["OPENCODE_CORP_CONFIG"]
      else process.env["OPENCODE_CORP_CONFIG"] = previous
    }
  })
})

// --- Эталонный корп-конфиг (S-C1, S-C4) ---

describe("corp/config/opencode.corp.json (AC-01, AC-07)", () => {
  test("AC-01: каталог corp/ содержит обязательные файлы", async () => {
    for (const entry of [
      "corp/config/opencode.corp.json",
      "corp/README.md",
      "corp/patches.md",
      "corp/docs/spec.md",
      "corp/docs/acceptance-criteria.yaml",
      "corp/build.ts",
      "corp/upstream-sync.sh",
      "corp/plugin/README.md",
    ]) {
      expect(await Bun.file(path.join(ROOT, entry)).exists(), entry).toBe(true)
    }
  })

  test("AC-07: корп-конфиг валиден по схеме конфига OpenCode и задаёт корпоративные умолчания", async () => {
    const text = await fs.readFile(path.join(ROOT, "corp/config/opencode.corp.json"), "utf8")
    const data = JSON.parse(text)
    const parsed = ConfigParse.schema(ConfigV1.Info, data, "corp/config/opencode.corp.json")

    expect(parsed.autoupdate).toBe(false)
    expect(parsed.share).toBe("disabled")
    expect(parsed.enabled_providers).toEqual(["magnit_prod"])
    expect(parsed.model).toBe("magnit_prod/MagnitCopilot")
    const provider = parsed.provider?.["magnit_prod"]
    expect(provider?.npm).toBe("@ai-sdk/openai-compatible")
    // S-C4b/D-21: ключ приходит только из auth-store, поэтому в конфиге его нет ни в каком виде.
    expect(provider?.options?.["apiKey"]).toBeUndefined()
    expect(provider?.options?.["baseURL"]).toBe(CORP_MODEL_BASE_URL)
    const model = provider?.models?.["MagnitCopilot"]
    expect(model?.limit?.context).toBeGreaterThan(0)
    expect(model?.limit?.output).toBeGreaterThan(0)
  })

  test("AC-07: в корп-конфиге нет секретов и нет ключа провайдера", async () => {
    const text = await fs.readFile(path.join(ROOT, "corp/config/opencode.corp.json"), "utf8")
    // S-C4/S-C4b: ключ выдаёт вход по SSO и хранит auth-store; ни литерала, ни подстановки {env:…}
    // в файле быть не должно — значение из конфига перебило бы ключ из auth-store (F37, D-21).
    for (const forbidden of ["apiKey", "MAGNIT_COPILOT_KEY", "copilot.magnit.ru"]) {
      expect(text, forbidden).not.toContain(forbidden)
    }
    for (const pattern of [/sk-[A-Za-z0-9]/, /Bearer\s+\S/, /"password"\s*:/i, /"token"\s*:\s*"[^"]+"/i]) {
      expect(text).not.toMatch(pattern)
    }
  })
})

// --- Слой конфигурации (S-C3) ---

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const WELL_KNOWN_URL = "https://corp-config.example.com"

const wellKnownAuth = Layer.mock(Auth.Service)({
  all: () =>
    Effect.succeed({
      [WELL_KNOWN_URL]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
    }),
})

const wellKnownClient = HttpClient.make((request) => {
  const respond = (body: unknown, status = 200) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    )
  if (request.url.includes(".well-known/opencode")) return Effect.succeed(respond({ config: { model: "other/X" } }))
  return Effect.succeed(respond({}, 404))
})

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(wellKnownAuth),
  Layer.provide(AccountTest.empty),
  Layer.provideMerge(infra),
  Layer.provide(NpmTest.noop),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, wellKnownClient)),
  Layer.provideMerge(FSUtil.defaultLayer),
)

const it = testEffect(configLayer)

const clearEffect = Config.use.invalidate().pipe(Effect.scoped, Effect.provide(configLayer))
const clear = () => Effect.runPromise(clearEffect)

beforeEach(clear)
afterEach(async () => {
  delete process.env["OPENCODE_CORP_CONFIG"]
  await clear()
})

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* clearEffect
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* clearEffect
      }),
  )

const withInstanceDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory: dir }),
    provideInstanceEffect(dir),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )

/** Дерево конфигов: глобальный конфиг пользователя + каталог проекта. */
const withTree = <A, E, R>(
  global: object | undefined,
  effect: (input: { globalFile: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const globalDir = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    const globalFile = path.join(globalDir, "opencode.json")
    if (global)
      yield* FSUtil.use.writeWithDirs(
        globalFile,
        JSON.stringify({ $schema: "https://opencode.ai/config.json", ...global }),
      )
    yield* Effect.promise(() => Filesystem.write(path.join(directory, ".keep"), ""))
    return yield* withGlobalConfigDir(globalDir, withInstanceDir(directory, effect({ globalFile })))
  })

const CORP_LAYER = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  model: "magnit_prod/MagnitCopilot",
})

describe("corp — слой конфигурации (AC-05, AC-06, AC-11, AC-118)", () => {
  it.effect(
    "AC-05: корп-слой ниже well-known и ниже глобального конфига, но его умолчания сохраняются",
    Effect.gen(function* () {
      process.env["OPENCODE_CORP_CONFIG"] = CORP_LAYER
      return yield* withTree({ model: "user/Y" }, () =>
        Effect.gen(function* () {
          const config = yield* Config.Service.use((svc) => svc.get())
          expect(config.model).toBe("user/Y")
          expect(config.autoupdate).toBe(false)
          expect(config.share).toBe("disabled")
        }),
      )
    }),
    60_000,
  )

  it.effect(
    "AC-05: без глобального конфига действует well-known, а не корп-слой",
    Effect.gen(function* () {
      process.env["OPENCODE_CORP_CONFIG"] = CORP_LAYER
      return yield* withTree(undefined, () =>
        Effect.gen(function* () {
          const config = yield* Config.Service.use((svc) => svc.get())
          expect(config.model).toBe("other/X")
          expect(config.autoupdate).toBe(false)
        }),
      )
    }),
    60_000,
  )

  it.effect(
    "AC-06: синтаксически неверный JSON корп-слоя не роняет загрузку конфига",
    Effect.gen(function* () {
      process.env["OPENCODE_CORP_CONFIG"] = "{ это не JSON"
      return yield* withTree({ model: "user/Y" }, () =>
        Effect.gen(function* () {
          const config = yield* Config.Service.use((svc) => svc.get())
          expect(config.model).toBe("user/Y")
          // Корп-слой пуст: его умолчания не применились.
          expect(config.autoupdate).toBeUndefined()
        }),
      )
    }),
    60_000,
  )

  it.effect(
    "AC-04: без корп-конфига слой отсутствует и поведение прежнее",
    Effect.gen(function* () {
      delete process.env["OPENCODE_CORP_CONFIG"]
      return yield* withTree({ model: "user/Y" }, () =>
        Effect.gen(function* () {
          const config = yield* Config.Service.use((svc) => svc.get())
          expect(config.model).toBe("user/Y")
          expect(config.autoupdate).toBeUndefined()
        }),
      )
    }),
    60_000,
  )

  it.effect(
    "AC-11: загрузка конфига с корп-слоем не изменяет файл глобального конфига",
    Effect.gen(function* () {
      process.env["OPENCODE_CORP_CONFIG"] = CORP_LAYER
      return yield* withTree({ model: "user/Y" }, ({ globalFile }) =>
        Effect.gen(function* () {
          const before = yield* Effect.promise(() => fs.readFile(globalFile, "utf8"))
          yield* Config.Service.use((svc) => svc.get())
          const after = yield* Effect.promise(() => fs.readFile(globalFile, "utf8"))
          expect(after).toBe(before)
        }),
      )
    }),
    60_000,
  )
})

// --- Персист действий витрины в глобальный конфиг (S-C7, S-V7, D-7) ---

const withGlobalJsonc = <A, E, R>(text: string, effect: (input: { file: string }) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const globalDir = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    const file = path.join(globalDir, "opencode.jsonc")
    yield* FSUtil.use.writeWithDirs(file, text)
    yield* Effect.promise(() => Filesystem.write(path.join(directory, ".keep"), ""))
    return yield* withGlobalConfigDir(globalDir, withInstanceDir(directory, effect({ file })))
  })

const JSONC = `{
  // корпоративный конфиг пользователя
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "mcp": {
    // уже подключённый сервер
    "tag": { "type": "remote", "url": "https://hub.test/mcp/tag", "enabled": true }
  }
}
`

describe("corp — запись mcp.<alias> в глобальный конфиг (AC-12)", () => {
  it.effect(
    "AC-12: «Подключить» меняет только раздел mcp.<alias>, комментарии .jsonc сохраняются",
    Effect.gen(function* () {
      return yield* withGlobalJsonc(JSONC, ({ file }) =>
        Effect.gen(function* () {
          const patch = CorpConnectors.connectPatch(
            {
              alias: "gitlab",
              title: "GitLab",
              status: "ga",
              mode: "facade",
              mcp_url: "https://hub.test/mcp/gitlab",
            },
            "readonly",
          )
          yield* Config.Service.use((svc) => svc.updateGlobal(patch))

          const after = yield* Effect.promise(() => fs.readFile(file, "utf8"))
          expect(after).toContain("// корпоративный конфиг пользователя")
          expect(after).toContain("// уже подключённый сервер")
          expect(after).toContain('"autoupdate": false')

          const parsed = JSON.parse(after.replace(/^\s*\/\/.*$/gm, ""))
          expect(parsed.autoupdate).toBe(false)
          expect(parsed.mcp.tag).toEqual({ type: "remote", url: "https://hub.test/mcp/tag", enabled: true })
          expect(parsed.mcp.gitlab).toEqual({
            type: "remote",
            url: "https://hub.test/mcp/gitlab",
            enabled: true,
            oauth: { scope: "gitlab:readonly" },
          })
        }),
      )
    }),
    60_000,
  )

  it.effect(
    "AC-62: «Отключить» гасит запись, не удаляя её и не трогая соседние",
    Effect.gen(function* () {
      return yield* withGlobalJsonc(JSONC, ({ file }) =>
        Effect.gen(function* () {
          yield* Config.Service.use((svc) => svc.updateGlobal(CorpConnectors.disconnectPatch("tag")))
          const after = yield* Effect.promise(() => fs.readFile(file, "utf8"))
          const parsed = JSON.parse(after.replace(/^\s*\/\/.*$/gm, ""))
          expect(parsed.mcp.tag).toEqual({ type: "remote", url: "https://hub.test/mcp/tag", enabled: false })
          expect(parsed.autoupdate).toBe(false)
        }),
      )
    }),
    60_000,
  )
})
