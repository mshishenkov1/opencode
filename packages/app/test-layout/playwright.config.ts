import fs from "fs"
import os from "os"
import path from "path"
import { defineConfig, devices } from "@playwright/test"

/**
 * Отдельная конфигурация для тестов раскладки корп-окон (BUG-I10-002).
 *
 * Основная `packages/app/playwright.config.ts` поднимает dev-сервер приложения и ждёт сервер
 * opencode — для измерения раскладки витрины это лишнее и делает тест непригодным для быстрого
 * прогона. Здесь `webServer` нет вовсе: фикстура собирается вайтом в `test.beforeAll`, а страница
 * получает собранные скрипт и стили через `addScriptTag`/`addStyleTag`.
 *
 * **Браузер.** По умолчанию используется chromium, скачанный `playwright install chromium`. Если его
 * нет (типичная машина разработчика без установленных браузеров Playwright), но в системе есть
 * Google Chrome, конфигурация переключается на него каналом `chrome` — ничего скачивать не нужно.
 * Явно задать канал можно переменной `PLAYWRIGHT_CHANNEL`.
 */

const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), "Library/Caches/ms-playwright")

function hasBundledChromium() {
  try {
    return fs.readdirSync(browsersPath).some((entry) => entry.startsWith("chromium"))
  } catch {
    return false
  }
}

const LOCAL_CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]

function localChromeChannel() {
  if (LOCAL_CHROME.some((file) => fs.existsSync(file))) return "chrome" as const
  return undefined
}

const channel = process.env.PLAYWRIGHT_CHANNEL ?? (hasBundledChromium() ? undefined : localChromeChannel())

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.layout.test.ts",
  outputDir: "./test-results",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["line"]],
  use: {
    ...devices["Desktop Chrome"],
    ...(channel ? { channel } : {}),
    // Окно заведомо выше корп-окна обеих веток (600px и 560px): панель получает свою полную высоту.
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium" }],
})
