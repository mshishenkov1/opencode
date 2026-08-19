#!/usr/bin/env bun
/**
 * Дымовая проверка корпоративного слоя без обращения к внешним системам (S-Q8).
 *
 * Поднимает HTTP-мок Hub на 127.0.0.1 (контракты §3 спецификации: `/health`, `/cli/*`, `/api/*`),
 * запускает `opencode corp status` и `opencode corp login` в изолированных `XDG_*`-каталогах
 * и проверяет коды выхода и вывод. Реальный Hub, LiteLLM и браузер не задействуются.
 *
 *   bun run corp/smoke.ts
 */

import { spawn } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const ENTRY = path.join(ROOT, "packages/opencode/src/index.ts")

const USER = { user_id: "u-1", email: "ivan@magnit.ru" }
const TEAMS = [
  { team_id: "team-platform", team_alias: "Платформа" },
  { team_id: "team-retail", team_alias: "Розница" },
]
const CATALOG = {
  version: "2026-08-19.1",
  servers: [
    {
      alias: "gitlab-platform",
      title: "GitLab Платформа",
      description: "Merge requests, pipelines, issues",
      owner: "Платформа",
      status: "ga",
      mode: "facade",
      mcp_url: "",
      permission_model: {
        kind: "header_groups",
        groups: [
          { id: "read", title: "Чтение", preset: "readonly" },
          { id: "write", title: "Запись", preset: "readwrite" },
        ],
        always: ["gitlab-platform_search"],
      },
      connection: { status: "not_connected" },
    },
    {
      alias: "tag",
      title: "ТЭГ",
      description: "Корпоративный ассистент",
      owner: "ТЭГ",
      status: "beta",
      mode: "native",
      mcp_url: "",
      permission_model: { kind: "consent", presets: { default: "Экран согласия сервера" } },
      connection: { status: "not_connected" },
    },
  ],
}

interface LoginState {
  polls: number
  teamSelected?: string
}

function startMockHub() {
  const logins = new Map<string, LoginState>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (url.pathname === "/health") return json({ status: "ok" })

      if (url.pathname === "/cli/start" && request.method === "POST") {
        const loginId = `login-${logins.size + 1}`
        logins.set(loginId, { polls: 0 })
        return json({
          login_id: loginId,
          poll_secret: "secret-do-not-leak",
          browser_url: `${url.origin}/ui/login/${loginId}`,
          user_code: "MGNT-4271",
          expires_in: 60,
        })
      }

      const pollMatch = url.pathname.match(/^\/cli\/poll\/([^/]+)$/)
      if (pollMatch) {
        const state = logins.get(pollMatch[1])
        if (!state) return json({ error: "login_expired" }, 404)
        if (request.headers.get("x-hub-poll-secret") !== "secret-do-not-leak")
          return json({ error: "forbidden" }, 403)
        state.polls += 1
        if (state.teamSelected)
          return json({
            status: "ready",
            key: "sk-magnit-persistent",
            key_kind: "persistent",
            user: USER,
            team_id: state.teamSelected,
          })
        if (state.polls === 1) return json({ status: "pending" })
        return json({ status: "team_selection_required", teams: TEAMS })
      }

      const teamMatch = url.pathname.match(/^\/cli\/poll\/([^/]+)\/team$/)
      if (teamMatch && request.method === "POST") {
        const state = logins.get(teamMatch[1])
        if (!state) return json({ error: "login_expired" }, 404)
        return request.json().then((body: any) => {
          if (!TEAMS.some((team) => team.team_id === body.team_id)) return json({ error: "invalid_team" }, 400)
          state.teamSelected = body.team_id
          return json({ status: "pending" })
        }) as unknown as Response
      }

      const bearer = request.headers.get("authorization")
      if (!bearer?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401)

      if (url.pathname === "/api/me")
        return json({ ...USER, key_kind: "persistent", created_at: new Date().toISOString() })

      if (url.pathname === "/api/catalog")
        return json({
          ...CATALOG,
          servers: CATALOG.servers.map((server) => ({ ...server, mcp_url: `${url.origin}/mcp/${server.alias}` })),
        })

      if (url.pathname === "/api/me/connections") return json([])

      return json({ error: "not_found" }, 404)
    },
  })
  return { server, hub: `http://127.0.0.1:${server.port}`, logins }
}

async function makeHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-corp-smoke-"))
  for (const sub of ["data", "config", "cache", "state"]) await fs.mkdir(path.join(dir, sub), { recursive: true })
  return dir
}

function env(home: string) {
  return {
    ...process.env,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    NO_COLOR: "1",
    CI: "1",
  }
}

async function run(home: string, args: string[]) {
  const proc = spawn({
    cmd: ["bun", "run", "--conditions=browser", ENTRY, ...args],
    cwd: ROOT,
    env: env(home),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, out: stdout + stderr }
}

const failures: string[] = []
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures.push(name)
  console.log(`FAIL  ${name}${detail ? `\n${detail}` : ""}`)
}

const { server, hub } = startMockHub()
console.log(`мок Hub: ${hub}`)

try {
  // 1. Ванильный режим: без адреса Hub корп-команды отключены (S-C5, S-C6).
  {
    const home = await makeHome()
    const result = await run(home, ["corp", "status"])
    check("corp status без Hub — код 1", result.code === 1, result.out)
    check("corp status без Hub — сообщение о ненастроенном режиме", result.out.includes("не настроен"), result.out)
  }

  // 2. Статус без ключа: адрес Hub известен, ключа нет (S-A11, S-Q8).
  const homeWithoutKey = await makeHome()
  {
    const result = await run(homeWithoutKey, ["corp", "status", "--hub", hub])
    check("corp status без ключа — код 1", result.code === 1, result.out)
    check("corp status без ключа — печатает адрес Hub", result.out.includes(hub), result.out)
    check("corp status без ключа — «ключ: нет»", result.out.includes("ключ: нет"), result.out)
    check("corp status без ключа — «Hub: доступен»", result.out.includes("Hub: доступен"), result.out)
  }

  // 3. Вход: start → pending → выбор команды → ready, ключ сохраняется (S-A10, S-A3).
  const home = await makeHome()
  {
    const result = await run(home, ["corp", "login", "--hub", hub, "--team", "team-platform"])
    check("corp login — код 0", result.code === 0, result.out)
    check("corp login — печатает код пользователя", result.out.includes("MGNT-4271"), result.out)
    check("corp login — печатает email", result.out.includes(USER.email), result.out)
    check("corp login — poll_secret не печатается", !result.out.includes("secret-do-not-leak"), result.out)
    check("corp login — ключ не печатается", !result.out.includes("sk-magnit-persistent"), result.out)

    const authFile = path.join(home, "data", "opencode", "auth.json")
    const auth = JSON.parse(await fs.readFile(authFile, "utf8"))
    check("вход сохранил запись magnit_prod", auth["magnit_prod"]?.type === "api", JSON.stringify(auth))
    check("вход сохранил ключ", auth["magnit_prod"]?.key === "sk-magnit-persistent")
    check("вход сохранил metadata.hub", auth["magnit_prod"]?.metadata?.hub === hub)
    check("вход сохранил metadata.team_id", auth["magnit_prod"]?.metadata?.team_id === "team-platform")
    const mode = (await fs.stat(authFile)).mode & 0o777
    check("auth.json с правами 0600", mode === 0o600, String(mode.toString(8)))
  }

  // 4. Статус с ключом (S-A11, S-Q8).
  {
    const result = await run(home, ["corp", "status", "--hub", hub])
    check("corp status с ключом — код 0", result.code === 0, result.out)
    check("corp status с ключом — «ключ: есть»", result.out.includes("ключ: есть"), result.out)
    check("corp status с ключом — печатает email", result.out.includes(USER.email), result.out)
    check("corp status с ключом — ключ не печатается", !result.out.includes("sk-magnit-persistent"), result.out)
  }

  // 5. Неизвестная команда при --team (S-A10).
  {
    const other = await makeHome()
    const result = await run(other, ["corp", "login", "--hub", hub, "--team", "team-unknown"])
    check("corp login с неизвестной командой — код 1", result.code === 1, result.out)
  }

  // 6. Витрина: каталог читается корп-роутом сервера (S-V1, S-V3).
  {
    const result = await run(home, ["corp", "status", "--hub", hub])
    check("кэш каталога не мешает статусу", result.code === 0, result.out)
  }

  // 7. Корп-роуты сервера: витрина читается через GET /corp/catalog (S-V1, S-V3, S-V6).
  {
    const port = 4123 + (process.pid % 500)
    const proc = spawn({
      cmd: ["bun", "run", "--conditions=browser", ENTRY, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      cwd: ROOT,
      env: { ...env(home), OPENCODE_CORP_HUB_URL: hub },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    try {
      const base = `http://127.0.0.1:${port}`
      let ready = false
      for (let attempt = 0; attempt < 120 && !ready; attempt++) {
        await Bun.sleep(500)
        ready = await fetch(`${base}/corp/status?directory=${encodeURIComponent(ROOT)}`)
          .then((response) => response.ok)
          .catch(() => false)
      }
      check("сервер поднялся и отвечает на /corp/status", ready)
      if (ready) {
        const status = (await fetch(`${base}/corp/status?directory=${encodeURIComponent(ROOT)}`).then((r) =>
          r.json(),
        )) as any
        check("/corp/status — корп-режим включён", status.enabled === true, JSON.stringify(status))
        check("/corp/status — ключ найден", status.authenticated === true, JSON.stringify(status))
        check("/corp/status — email пользователя", status.user?.email === USER.email, JSON.stringify(status))

        const catalog = (await fetch(`${base}/corp/catalog?directory=${encodeURIComponent(ROOT)}`).then((r) =>
          r.json(),
        )) as any
        check("/corp/catalog — источник hub", catalog.source === "hub", JSON.stringify(catalog).slice(0, 400))
        check("/corp/catalog — две карточки", catalog.servers?.length === 2, JSON.stringify(catalog).slice(0, 400))
        check(
          "/corp/catalog — карточки не подключены",
          catalog.servers?.every((card: any) => card.status === "not_connected"),
          JSON.stringify(catalog.servers).slice(0, 400),
        )
        check(
          "/corp/catalog — есть действие «Открыть в Hub»",
          catalog.servers?.[0]?.actions?.includes("open_hub"),
          JSON.stringify(catalog.servers?.[0]),
        )
        check(
          "/corp/catalog — permission_model проброшен",
          catalog.servers?.[0]?.permission_model?.kind === "header_groups",
          JSON.stringify(catalog.servers?.[0]?.permission_model),
        )

        const cacheDir = path.join(home, "data", "opencode", "corp")
        const cached = await fs.readdir(cacheDir).catch(() => [] as string[])
        check("каталог записан в кэш на диск", cached.some((name) => name.startsWith("catalog-")), cached.join(","))
      }
    } finally {
      proc.kill()
      await proc.exited
    }
  }

  // 8. Ванильный режим сервера: без адреса Hub корп-роуты отвечают 501 corp_disabled (S-C5, S-C6).
  {
    const port = 4623 + (process.pid % 500)
    const vanilla = await makeHome()
    const proc = spawn({
      cmd: ["bun", "run", "--conditions=browser", ENTRY, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
      cwd: ROOT,
      env: env(vanilla),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    try {
      const base = `http://127.0.0.1:${port}`
      let ready = false
      for (let attempt = 0; attempt < 120 && !ready; attempt++) {
        await Bun.sleep(500)
        ready = await fetch(`${base}/corp/status?directory=${encodeURIComponent(ROOT)}`)
          .then((response) => response.ok)
          .catch(() => false)
      }
      check("ванильный сервер отвечает на /corp/status", ready)
      if (ready) {
        const status = (await fetch(`${base}/corp/status?directory=${encodeURIComponent(ROOT)}`).then((r) =>
          r.json(),
        )) as any
        check("ванильный /corp/status — enabled=false", status.enabled === false, JSON.stringify(status))
        const catalog = await fetch(`${base}/corp/catalog?directory=${encodeURIComponent(ROOT)}`)
        check("ванильный /corp/catalog — 501", catalog.status === 501, String(catalog.status))
        const body = (await catalog.json()) as any
        check("ванильный /corp/catalog — corp_disabled", body?.error === "corp_disabled", JSON.stringify(body))
      }
    } finally {
      proc.kill()
      await proc.exited
    }
  }

  // 9. Мок Hub отвечает на /api/catalog авторизованному клиенту (§3.2).
  {
    const response = await fetch(`${hub}/api/catalog`, { headers: { authorization: "Bearer sk-magnit-persistent" } })
    const body = (await response.json()) as typeof CATALOG
    check("каталог мока отдаёт две карточки", body.servers.length === 2)
    check("facade-карточка получила mcp_url от Hub", body.servers[0].mcp_url.endsWith("/mcp/gitlab-platform"))
    const anonymous = await fetch(`${hub}/api/catalog`)
    check("каталог требует Bearer", anonymous.status === 401)
  }
} finally {
  server.stop(true)
}

if (failures.length) {
  console.error(`\nдымовая проверка провалена: ${failures.length}`)
  for (const name of failures) console.error(`  - ${name}`)
  process.exit(1)
}
console.log("\nдымовая проверка пройдена")
