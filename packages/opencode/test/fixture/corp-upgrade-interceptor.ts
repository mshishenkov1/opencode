/**
 * Перехватчик исходящих запросов для тестов явного апгрейда CLI (S-B14, S-Q11; AC-193…AC-196, AC-199).
 *
 * Подключается к процессу `opencode` через `bun --preload` и подменяет `globalThis.fetch`:
 *   - каждый запрос дописывается строкой `fetch <url>` в файл `CORP_NET_LOG` — по нему тест
 *     проверяет **все** перехваченные запросы, а не один;
 *   - на 127.0.0.1/localhost запрос выполняется по-настоящему (мок Hub или мок источника обновлений);
 *   - `api.github.com` отвечает телом из `CORP_STUB_GITHUB`, если оно задано (ванильный путь
 *     AC-196 должен доходить до конца, но наружу не выходить);
 *   - любой другой внешний адрес не выполняется вовсе: запрос падает, а тест видит его в журнале.
 *
 * Сети из тестов нет ни при каком исходе: даже неожиданный адрес наружу не уходит.
 */

import { appendFileSync } from "fs"

const log = process.env["CORP_NET_LOG"]

function record(line: string) {
  if (log) appendFileSync(log, `${line}\n`)
}

const realFetch = globalThis.fetch

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  record(`fetch ${url}`)

  let host = ""
  try {
    host = new URL(url).hostname
  } catch {
    host = ""
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return realFetch(input as never, init as never)

  const stub = process.env["CORP_STUB_GITHUB"]
  if (stub && url.includes("api.github.com"))
    return new Response(stub, { status: 200, headers: { "content-type": "application/json" } })

  throw new Error(`внешний запрос заблокирован тестом: ${url}`)
}) as typeof fetch
