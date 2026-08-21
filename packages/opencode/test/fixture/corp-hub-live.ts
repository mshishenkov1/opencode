/**
 * Живые тела ответов корпоративного Hub (§3.2) — фикстуры разбора каталога по S-V14.
 *
 * Сняты один раз с работающего стенда Hub `http://localhost:8080` 2026-08-21 запросами
 * `GET /api/catalog` и `GET /api/me/connections` с ключом провайдера `magnit_prod` из auth-store и
 * записаны сюда дословно, без правок формы. Тесты в сеть не ходят: они подают эти тела моку `fetch`
 * либо моку Hub.
 *
 * Фикстура снята с живого Hub намеренно (BUG-I4-008): прежние тела форка были написаны по тексту
 * спецификации и разошлись с контрактом (`presets` строками вместо объектов, `version` строкой
 * вместо числа) — тесты подтверждали неверную схему, и дефект дожил до пользователя. Всё, что
 * отличает эти тела от прежних фикстур, — форма живого Hub:
 *   - `version` — **число** (S-V14 п.1, D-29), клиент нормализует его к строке;
 *   - `permission_model.kind = "tool_filter"`, значение пресета — объект `{tools:[…]}` (§3.2);
 *   - `auth_kind = "user_token"` и неизвестное клиенту поле `auth_methods` (S-V14 п.4);
 *   - `GET /api/me/connections` — массив верхнего уровня, а не объект-конверт (S-V14 п.6).
 *
 * Секретов в телах нет: ключ уходил только заголовком `Authorization` и сюда не попадал.
 */

/** Тело `GET /api/catalog` живого Hub (2026-08-21), дословно. */
export const LIVE_CATALOG_BODY: Record<string, unknown> = {
  version: 1,
  servers: [
    {
      alias: "tag",
      title: "ТЭГ (Mattermost)",
      description: "Сообщения, каналы, треды, поиск, файлы корпоративного мессенджера ТЭГ.",
      owner: "Мирослав Шишенков",
      contact: "https://tag.magnit.ru",
      docs_url: "https://github.com/mshishenkov1/magnit-tag-mcp",
      status: "beta",
      mode: "facade",
      mcp_url: "http://localhost:8080/mcp/tag",
      permission_model: {
        kind: "tool_filter",
        presets: {
          readonly: {
            tools: [
              "whoami",
              "server_*",
              "resolve_channel",
              "get_*",
              "list_*",
              "search_*",
              "browse_public_channels",
              "summarize_*",
              "download_file",
            ],
          },
          readwrite: {
            tools: ["*"],
          },
        },
      },
      auth_kind: "user_token",
      auth_methods: [
        {
          id: "corp_oauth",
          title: "Корпоративная авторизация ТЭГ",
          type: "oauth2",
          available: false,
          unavailable_reason: "OAuth-приложение ТЭГ ещё не выдано администраторами",
        },
        {
          id: "session_token",
          title: "Токен сессии ТЭГ",
          type: "user_token",
          available: true,
          unavailable_reason: null,
          field: {
            label: "Токен сессии ТЭГ",
            hint: "ТЭГ → Профиль → Настройки безопасности → Личные токены доступа; либо значение cookie MMAUTHTOKEN",
            docs_url: "https://github.com/mshishenkov1/magnit-tag-mcp#токен",
            secret: true,
            placeholder: null,
            min_length: 1,
            max_length: 4096,
          },
        },
      ],
      connection: {
        status: "connected",
        preset: "readonly",
        updated_at: "2026-08-21T06:39:54.386790+00:00",
      },
    },
  ],
}

/** Тело `GET /api/me/connections` живого Hub (2026-08-21), дословно. */
export const LIVE_CONNECTIONS_BODY: unknown[] = [
  {
    alias: "tag",
    status: "connected",
    preset: "readonly",
    groups: [],
    created_at: "2026-08-20T22:00:39.068829+00:00",
    updated_at: "2026-08-21T06:39:54.386790+00:00",
  },
]

/** Живая карточка `tag` из каталога — та же, что в `LIVE_CATALOG_BODY.servers[0]`. */
export const LIVE_TAG_CARD = (LIVE_CATALOG_BODY["servers"] as Record<string, unknown>[])[0]!

/** Свежая копия живого тела: тесты меняют фикстуру под свой случай, не задевая соседние. */
export function liveCatalogBody(): Record<string, unknown> {
  return structuredClone(LIVE_CATALOG_BODY)
}

/** Свежая копия живой карточки `tag`. */
export function liveTagCard(): Record<string, unknown> {
  return structuredClone(LIVE_TAG_CARD)
}

/** Свежая копия живого тела `GET /api/me/connections`. */
export function liveConnectionsBody(): unknown[] {
  return structuredClone(LIVE_CONNECTIONS_BODY)
}
