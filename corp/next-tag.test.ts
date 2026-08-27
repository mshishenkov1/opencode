import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * Вычисление номера и имени тега корп-сборки (S-B16 п. 1, S-Q11; AC-254…AC-257).
 *
 * По случаю на каждое правило, на ПОДМЕНЁННОМ списке тегов и без сетевых обращений: каждый случай
 * поднимает свой временный git-репозиторий с нужным набором тегов и нужной версией upstream в
 * `packages/opencode/package.json`. Настоящий репозиторий не трогается — его теги и история к
 * правилам номера отношения не имеют, а прогон, зависящий от них, был бы невоспроизводим.
 *
 * Почему не проверка подстрок в YAML: подстроки не падают при осмысленной поломке. Набор ниже
 * обязан падать как минимум на трёх мутациях, которые прежняя редакция не ловила, — `sort -n` → `sort`,
 * потеря якоря `$` в sed, перестановка веток сброса и инкремента.
 *
 * Запуск: `bun --cwd packages/opencode test ../../corp/next-tag.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const temporary: string[] = []

afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, args: string[]) {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "corp-test",
      GIT_AUTHOR_EMAIL: "corp@test",
      GIT_COMMITTER_NAME: "corp-test",
      GIT_COMMITTER_EMAIL: "corp@test",
    },
  })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString()
}

/**
 * Репозиторий-песочница: настоящий `corp/build.ts` (единственный источник версии), выдуманный
 * `packages/opencode/package.json` с заданной версией upstream и заданный список тегов.
 *
 * `corp/build.ts` копируется, а не подделывается: правило «версия тега берётся из того же кода, что
 * версия артефактов» проверяется только настоящим кодом. Ему из репозитория нужен ровно
 * `packages/opencode/package.json` — до сборки он не доходит.
 */
function sandbox(options: { upstream: string; tags?: string[]; tagHead?: string; version?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corp-next-tag-"))
  temporary.push(dir)
  fs.mkdirSync(path.join(dir, "corp"), { recursive: true })
  fs.mkdirSync(path.join(dir, "packages/opencode"), { recursive: true })
  fs.copyFileSync(path.join(ROOT, "corp/build.ts"), path.join(dir, "corp/build.ts"))
  fs.copyFileSync(path.join(ROOT, "corp/next-tag.sh"), path.join(dir, "corp/next-tag.sh"))
  fs.chmodSync(path.join(dir, "corp/next-tag.sh"), 0o755)
  fs.writeFileSync(path.join(dir, "corp/version"), `${options.version ?? "1"}\n`)
  fs.writeFileSync(
    path.join(dir, "packages/opencode/package.json"),
    JSON.stringify({ name: "opencode", version: options.upstream }, null, 2),
  )

  git(dir, ["init", "-q", "-b", "corp/i4-sso-connectors"])
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-q", "-m", "corp: прежний состав раздачи"])
  // Уже выпущенные теги живут на ПРЕЖНИХ коммитах, а HEAD — свежий мерж upstream: так выглядит
  // ветка в момент запуска автотега. Тег на самом HEAD — отдельный случай (options.tagHead).
  for (const tag of options.tags ?? []) git(dir, ["tag", tag])
  git(dir, ["commit", "-q", "--allow-empty", "-m", `corp: слить upstream v${options.upstream}`])
  if (options.tagHead) git(dir, ["tag", options.tagHead])
  return dir
}

/** Запуск corp/next-tag.sh в песочнице; возвращает разобранные пары key=value и код выхода. */
function nextTag(dir: string) {
  const proc = Bun.spawnSync({
    cmd: ["bash", path.join(dir, "corp/next-tag.sh")],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CORP_BUILD: "", NO_COLOR: "1" },
  })
  const out = proc.stdout.toString()
  const values: Record<string, string> = {}
  for (const line of out.split("\n")) {
    const match = /^([a-z_]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1]!] = match[2]!
  }
  return { code: proc.exitCode, values, out, err: proc.stderr.toString() }
}

describe("corp/next-tag.sh — номер корп-сборки (S-B16 п. 1, S-Q11)", () => {
  test("AC-254: версия upstream сменилась — счёт начинается заново с 1", () => {
    // Последний выпущенный тег — v1.17.9-magnit.3, в ветку влит upstream 1.18.0.
    const dir = sandbox({ upstream: "1.18.0", tags: ["v1.17.9-magnit.1", "v1.17.9-magnit.2", "v1.17.9-magnit.3"] })
    const result = nextTag(dir)
    expect(result.code).toBe(0)
    expect(result.values["skip"]).toBe("false")
    expect(result.values["build"]).toBe("1")
    expect(result.values["tag"]).toBe("v1.18.0-magnit.1")
  }, 30_000)

  test("AC-254: тегов нет вовсе — первая сборка базы получает номер 1", () => {
    const dir = sandbox({ upstream: "1.17.9" })
    const result = nextTag(dir)
    expect(result.values["skip"]).toBe("false")
    expect(result.values["tag"]).toBe("v1.17.9-magnit.1")
  }, 30_000)

  test("AC-255: версия upstream та же — номер на единицу больше максимума", () => {
    const dir = sandbox({ upstream: "1.17.9", tags: ["v1.17.9-magnit.1", "v1.17.9-magnit.2", "v1.17.9-magnit.3"] })
    const result = nextTag(dir)
    expect(result.code).toBe(0)
    expect(result.values["skip"]).toBe("false")
    expect(result.values["build"]).toBe("4")
    expect(result.values["tag"]).toBe("v1.17.9-magnit.4")
  }, 30_000)

  test("AC-255: считается МАКСИМУМ, а не последний по алфавиту — после девятой сборки номер не едет назад", () => {
    // Мутация `sort -n` → `sort` даёт максимум «2» и тег v1.17.9-magnit.3 — уже выпущенный состав.
    const dir = sandbox({
      upstream: "1.17.9",
      tags: ["v1.17.9-magnit.1", "v1.17.9-magnit.2", "v1.17.9-magnit.9", "v1.17.9-magnit.10"],
    })
    const result = nextTag(dir)
    expect(result.values["build"]).toBe("11")
    expect(result.values["tag"]).toBe("v1.17.9-magnit.11")
  }, 30_000)

  test("AC-255: считаются только теги ТОЧНОГО вида v<upstream>-magnit.<N>", () => {
    // Мутация «потерян якорь $ в sed» засчитала бы v1.17.9-magnit.99.tmp за номер 99 и перепрыгнула
    // бы через девяносто пять номеров, а v1.17.9-magnit.4rc — за номер 4.
    const dir = sandbox({
      upstream: "1.17.9",
      tags: ["v1.17.9-magnit.3", "v1.17.9-magnit.99.tmp", "v1.17.9-magnit.4rc"],
    })
    const result = nextTag(dir)
    expect(result.values["build"]).toBe("4")
    expect(result.values["tag"]).toBe("v1.17.9-magnit.4")
  }, 30_000)

  test("AC-255: теги ЧУЖОЙ версии upstream в счёт не идут", () => {
    const dir = sandbox({
      upstream: "1.18.0",
      tags: ["v1.17.9-magnit.7", "v1.18.0-magnit.1", "v2.0.0-magnit.5"],
    })
    const result = nextTag(dir)
    expect(result.values["build"]).toBe("2")
    expect(result.values["tag"]).toBe("v1.18.0-magnit.2")
  }, 30_000)

  test("AC-256: коммит уже помечен — успех, нового тега не предлагается", () => {
    const dir = sandbox({ upstream: "1.17.9", tags: ["v1.17.9-magnit.3"], tagHead: "v1.17.9-magnit.4" })
    const result = nextTag(dir)
    expect(result.code).toBe(0)
    expect(result.values["skip"]).toBe("true")
    expect(result.values["reason"]).toBe("commit-already-tagged")
    expect(result.values["build"]).toBeUndefined()
    expect(result.values["tag"]).toBeUndefined()
  }, 30_000)

  test("AC-256: предложенный тег никогда не совпадает с уже выпущенным", () => {
    // Свойство, которое охраняет последняя проверка скрипта: имя нового тега свободно. Мутация
    // «максимум + 1» → «максимум» ломает именно его — скрипт предложил бы уже выпущенный состав,
    // а с проверкой скажет skip=true, и утверждения на build/tag ниже упадут.
    for (const tags of [
      [],
      ["v1.17.9-magnit.1"],
      ["v1.17.9-magnit.1", "v1.17.9-magnit.2", "v1.17.9-magnit.3"],
      ["v1.17.9-magnit.9", "v1.17.9-magnit.10"],
    ]) {
      const dir = sandbox({ upstream: "1.17.9", tags })
      const result = nextTag(dir)
      expect(result.values["skip"], tags.join(",")).toBe("false")
      const tag = result.values["tag"]!
      expect(tags, tag).not.toContain(tag)
      const exists = Bun.spawnSync({
        cmd: ["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(exists.exitCode, `${tag} уже существует`).not.toBe(0)
    }
  }, 60_000)

  test("AC-254: имя тега берётся из corp/build.ts --print-version, а не собирается заново", () => {
    // Единственный источник версии (S-B1): напечатанное имя тега обязано совпасть с версией,
    // которую тот же код проставит артефактам при CORP_BUILD = вычисленному номеру.
    const dir = sandbox({ upstream: "1.18.0", tags: ["v1.18.0-magnit.6"] })
    const result = nextTag(dir)
    expect(result.values["build"]).toBe("7")

    const printed = Bun.spawnSync({
      cmd: [process.execPath, "run", path.join(dir, "corp/build.ts"), "--print-version"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CORP_BUILD: result.values["build"]! },
    })
    expect(`v${printed.stdout.toString().trim()}`).toBe(result.values["tag"])
  }, 30_000)

  test("S-B16: скрипт ничего не создаёт — ни тега, ни коммита, ни правки corp/version", () => {
    const dir = sandbox({ upstream: "1.17.9", tags: ["v1.17.9-magnit.1"] })
    const tagsBefore = git(dir, ["tag", "--list"])
    const headBefore = git(dir, ["rev-parse", "HEAD"])
    const versionBefore = fs.readFileSync(path.join(dir, "corp/version"), "utf8")

    expect(nextTag(dir).values["tag"]).toBe("v1.17.9-magnit.2")

    expect(git(dir, ["tag", "--list"])).toBe(tagsBefore)
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(headBefore)
    expect(fs.readFileSync(path.join(dir, "corp/version"), "utf8")).toBe(versionBefore)
    expect(git(dir, ["status", "--porcelain"])).toBe("")
  }, 30_000)
})

/**
 * Стык скрипта и workflow (S-B16 п. 1; AC-256, AC-257).
 *
 * Скрипт считает, workflow ставит. Здесь проверяется то, что осталось в YAML и что скриптом не
 * достаётся: условие запуска (обычный корп-коммит тега не порождает) и порядок push'ей.
 */
describe("corp-release.yml — стык с corp/next-tag.sh (S-B16 п. 1)", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/corp-release.yml"), "utf8")

  test("S-B16: номер считает corp/next-tag.sh, второго вычисления в YAML нет", () => {
    expect(workflow).toContain("corp/next-tag.sh")
    // Арифметика и разбор тегов остались в скрипте: в YAML их быть не должно.
    expect(workflow).not.toContain("git tag --list")
    expect(workflow).not.toContain("sort -n")
    expect(workflow).not.toMatch(/build=\$\(\(/)
  })

  test("AC-257: тег порождает только коммит мержа upstream — по случаю на сообщение", () => {
    const condition = /startsWith\(github\.event\.head_commit\.message, '([^']+)'\)/.exec(workflow)?.[1]
    expect(condition).toBe("corp: слить upstream ")
    const cases: [string, boolean][] = [
      // Ровно так коммитит мерж upstream-sync.yml — единственный случай срабатывания.
      ["corp: слить upstream v1.18.0", true],
      ["corp: слить upstream v1.17.9", true],
      // Обычные корп-коммиты и коммит самого автотега тега не порождают: цикла запусков нет.
      ["corp: правка витрины", false],
      ["corp: версия сборки 4", false],
      ["corp: тесты — фид апдейтера", false],
      ["fix: слить upstream v1.18.0", false],
    ]
    for (const [message, expected] of cases) {
      expect(message.startsWith(condition!), message).toBe(expected)
    }
  })

  test("AC-256: постановка тега последовательна — очередь на репозиторий без отмены", () => {
    // Два одновременных запуска вычислили бы один и тот же N. Отмена предыдущего запуска тоже
    // запрещена: она оборвала бы постановку между push ветки и push тега.
    expect(workflow).toContain("group: corp-release")
    expect(workflow).toContain("cancel-in-progress: false")
  })

  test("S-B16: ветка пушится РАНЬШЕ тега — тег обязан указывать на коммит ветки", () => {
    // Перестановка push'ей оставляет тег на коммите, которого нет в ветке: corp/version в сборке
    // по тегу разойдётся с историей, а следующий автотег посчитает N по «висящему» тегу.
    const branchPush = workflow.indexOf('git push origin "HEAD:${GITHUB_REF_NAME}"')
    const tagPush = workflow.indexOf('git push origin "${{ steps.version.outputs.tag }}"')
    expect(branchPush).toBeGreaterThan(-1)
    expect(tagPush).toBeGreaterThan(-1)
    expect(branchPush).toBeLessThan(tagPush)
  })

  test("S-B16: корп-коммит автотега начинается с «corp: » (S-C8, AC-13)", () => {
    expect(workflow).toContain('git commit -m "corp: версия сборки')
  })
})
