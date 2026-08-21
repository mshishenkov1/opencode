import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin, { resolveChannel } from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

// corp: канал `magnit` — корпоративная раздача; `latest` (канал раздачи CLI) переводится в него,
// прежде переводился в `prod` — идентичность ванильного апстрима (S-B3, S-B10). Неизвестное
// значение — ошибка, а не молчаливый откат в `dev` (D-25); незаданное — `dev`.
//
// Разбор берётся из `@opencode-ai/app/vite` — того же места, откуда его берёт `define` веб-интерфейса
// (`VITE_OPENCODE_CHANNEL`). Своя копия здесь означала два расходящихся источника канала: главный
// процесс знал `magnit`, а интерфейс сваливался в `dev` и рисовал в заголовке ярлык «DEV».
const channel = resolveChannel()

// corp: адрес сервера обновлений в главный процесс (S-B11, S-C2) — по образцу OPENCODE_CORP_HUB_URL.
// Пустая строка означает «адрес не задан»: апдейтер выключается целиком (UPDATER_ENABLED).
const corpUpdateUrl = process.env.CORP_DESKTOP_UPDATE_URL?.trim().replace(/\/+$/, "") ?? ""

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.OPENCODE_CORP_UPDATE_URL": JSON.stringify(corpUpdateUrl),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
