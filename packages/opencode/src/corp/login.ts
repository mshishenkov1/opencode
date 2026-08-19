/**
 * Сессии входа по SSO (S-A2, S-A4, S-A9).
 *
 * `poll_secret`, выданный Hub, живёт **только в памяти процесса**: наружу отдаются лишь `login_id`,
 * `user_code`, `browser_url` и `expires_in`. Ни в ответы, ни в логи, ни в события секрет не попадает.
 */

export const POLL_INTERVAL_MS = 2000
export const DEFAULT_EXPIRES_IN_S = 600
/** Сколько подряд сетевых ошибок/502 терпит опрос до `hub_unavailable` (S-A4). */
export const MAX_CONSECUTIVE_HUB_ERRORS = 5

export interface Session {
  loginId: string
  pollSecret: string
  hubUrl: string
  expiresAt: number
  teams?: { team_id: string; team_alias: string }[]
  hubErrors: number
}

export interface Store {
  create(input: { loginId: string; pollSecret: string; hubUrl: string; expiresIn?: number }): Session
  get(loginId: string): Session | undefined
  drop(loginId: string): void
  /** Удаляет истёкшие сессии; вызывается перед каждым обращением. */
  sweep(): void
  size(): number
}

export function makeStore(clock: () => number = Date.now): Store {
  const sessions = new Map<string, Session>()

  const sweep = () => {
    const now = clock()
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id)
    }
  }

  return {
    create(input) {
      sweep()
      const session: Session = {
        loginId: input.loginId,
        pollSecret: input.pollSecret,
        hubUrl: input.hubUrl,
        expiresAt: clock() + (input.expiresIn ?? DEFAULT_EXPIRES_IN_S) * 1000,
        hubErrors: 0,
      }
      sessions.set(input.loginId, session)
      return session
    },
    get(loginId) {
      sweep()
      return sessions.get(loginId)
    },
    drop(loginId) {
      sessions.delete(loginId)
    },
    sweep,
    size() {
      return sessions.size
    },
  }
}

/** Единый на процесс сервера store сессий входа (S-A2). */
export const store = makeStore()

/**
 * Публичное представление сессии для UI — без `poll_secret` (S-A2).
 */
export function publicView(session: Session, userCode: string, browserUrl: string, now: number = Date.now()) {
  return {
    login_id: session.loginId,
    user_code: userCode,
    browser_url: browserUrl,
    expires_in: Math.max(0, Math.round((session.expiresAt - now) / 1000)),
  }
}

/**
 * Метаданные записи auth-store для ключа Hub (S-A3, D-3).
 * Значения `Auth.Api.metadata` — строки, поэтому числа/undefined отбрасываются.
 */
export function authMetadata(input: {
  hubUrl: string
  keyKind: string
  userId: string
  teamId?: string
}): Record<string, string> {
  const metadata: Record<string, string> = {
    hub: input.hubUrl,
    key_kind: input.keyKind,
    user_id: input.userId,
  }
  if (input.teamId) metadata["team_id"] = input.teamId
  return metadata
}
