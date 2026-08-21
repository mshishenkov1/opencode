import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

// corp: единственный источник канала для интерфейса и для главного процесса Desktop (S-B10).
// Прежде здесь была вторая, расходящаяся копия разбора: конфигурация electron-vite уже знала канал
// `magnit`, а этот файл о нём не знал и молча сваливался в `dev` — отсюда ярлык «DEV» в заголовке
// окна корпоративной сборки (`ChannelIndicator` в src/components/titlebar.tsx) и включённые по
// умолчанию непоказанные макеты (`newLayoutDesignsDefault`). Тот же молчаливый откат дал
// «OpenCode Dev» в раздаче (BUG-I4-003), поэтому неизвестное значение здесь — ошибка (D-25).
// Незаданная переменная по-прежнему означает `dev`: это режим локальной разработки.
export const CHANNELS = ["dev", "beta", "prod", "magnit", "latest"]

/**
 * Канал сборки в терминах интерфейса и Desktop (S-B3, S-B10).
 *
 * `latest` — канал раздачи CLI, `magnit` — канал раздачи Desktop; оба дают `magnit`. Прежде
 * `latest` переводился в `prod`, то есть в идентичность ванильного апстрима (ревизия 1.6).
 *
 * @returns {"dev" | "beta" | "prod" | "magnit"}
 */
export function resolveChannel() {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === undefined || raw === "") return "dev"
  if (raw === "latest" || raw === "magnit") return "magnit"
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  throw new Error(`неизвестный канал сборки: ${raw}; допустимые: ${CHANNELS.join(", ")}`)
}

const channel = resolveChannel()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
