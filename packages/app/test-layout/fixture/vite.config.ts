import path from "path"
import { fileURLToPath } from "url"
import { defineConfig } from "vite"
import desktopPlugin from "../../vite"

/**
 * Сборка оболочки витрины для измерения раскладки (BUG-I10-002).
 *
 * Плагины берутся те же, что у приложения (`packages/app/vite.js`): алиас `@`, tailwind и
 * `vite-plugin-solid`. Значит, и JSX, и CSS собираются ровно так же, как в отгружаемом бандле —
 * иначе тест мерил бы не то, что видит пользователь.
 *
 * Формат — `iife` одним файлом: Playwright вставляет собранный скрипт и стили прямо в страницу,
 * поэтому ни dev-сервера, ни сервера opencode тесту не нужно.
 */
const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [desktopPlugin] as any,
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: false,
    target: "esnext",
    lib: {
      entry: path.join(here, "shell.tsx"),
      formats: ["iife"],
      name: "CorpShellFixture",
      fileName: () => "shell.js",
      cssFileName: "shell",
    },
  },
})
