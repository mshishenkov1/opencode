interface ImportMetaEnv {
  readonly VITE_OPENCODE_SERVER_HOST: string
  readonly VITE_OPENCODE_SERVER_PORT: string
  // corp: `magnit` — канал корпоративной раздачи, в него переводится и `latest` (S-B3, S-B10)
  readonly VITE_OPENCODE_CHANNEL?: "dev" | "beta" | "prod" | "magnit"
  // corp: адрес Hub корпоративной сборки — задаётся при сборке веб-UI (S-C2, S-I2)
  readonly VITE_OPENCODE_CORP_HUB_URL?: string
  // corp: адрес статического каталога коннекторов — второй источник включённости (S-C10 п.1–2)
  readonly VITE_OPENCODE_CORP_CATALOG_URL?: string

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
