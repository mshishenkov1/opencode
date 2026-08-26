#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// corp: корпоративный слой — те же build-константы, что и у бинарника CLI (S-C2, S-B3).
// Этот бандл — сервер, встроенный в Desktop: без констант корп-режим в приложении выключен,
// хотя CLI из той же сборки корпоративный (BUG-I4-003). Без CORP_HUB_URL и без
// corp/config/opencode.corp.json константы не определяются — сборка ванильная (S-C6).
const corpDefine: Record<string, string> = {}
{
  const hubUrl = process.env["CORP_HUB_URL"]?.trim().replace(/\/+$/, "")
  if (hubUrl) corpDefine["OPENCODE_CORP_HUB_URL"] = JSON.stringify(hubUrl)
  // corp: внутренний источник обновлений CLI (S-B14). Без переменной константа не определяется —
  // тогда `opencode upgrade` в корп-сборке никуда не ходит и говорит об этом (D-34).
  const cliUpdateUrl = process.env["CORP_CLI_UPDATE_URL"]?.trim().replace(/\/+$/, "")
  if (cliUpdateUrl) corpDefine["OPENCODE_CORP_CLI_UPDATE_URL"] = JSON.stringify(cliUpdateUrl)
  // corp: адрес статического каталога (S-C10 п.1) — та же константа, что у бинарника CLI.
  const catalogUrl = process.env["CORP_CATALOG_URL"]?.trim().replace(/\/+$/, "")
  if (catalogUrl) corpDefine["OPENCODE_CORP_CATALOG_URL"] = JSON.stringify(catalogUrl)
  const corpConfigPath = path.resolve(dir, "../../corp/config/opencode.corp.json")
  if (fs.existsSync(corpConfigPath)) {
    const text = fs.readFileSync(corpConfigPath, "utf8").trim()
    if (text) corpDefine["OPENCODE_CORP_CONFIG"] = JSON.stringify(text)
  }
  if (Object.keys(corpDefine).length === 0) console.log("corp: build-константы не заданы, собирается ванильная сборка")
  else console.log(`corp: build-константы ${Object.keys(corpDefine).join(", ")}`)
}

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
    // corp: версия корп-сборки (S-B1) — как в script/build.ts, иначе встроенный сервер
    // сообщает «local» там, где CLI сообщает `1.17.9-magnit.N`.
    OPENCODE_VERSION: `'${Script.version}'`,
    ...corpDefine,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
