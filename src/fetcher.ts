import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readKeychainCredentials, readCredentialsFile, readOpenCodeAuth, refreshToken, isTokenExpired } from "./keychain.js"
import { fetchOAuthUsage, fetchOAuthProfile } from "./oauth-client.js"
import { extractSessionKey, fetchWebUsage } from "./cookie-reader.js"
import { detectClaude, probeCLIUsage, probeStatus } from "./cli-probe.js"
import type { UsageState, OAuthUsageResponse, ProfileResponse, AuthMethod } from "./types.js"

interface FetchResult {
  usage: OAuthUsageResponse | null
  profile: ProfileResponse | null
  authMethod: AuthMethod
}

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-claude-usage")
const CACHE_FILE = join(CACHE_DIR, "last.json")
const CACHE_MAX_AGE_MS = 10 * 60 * 1000

interface CachedResult {
  timestamp: number
  result: FetchResult
}

function readCache(): FetchResult | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8")
    const cached = JSON.parse(raw) as CachedResult
    if (Date.now() - cached.timestamp > CACHE_MAX_AGE_MS) return null
    if (!cached.result?.usage) return null
    return cached.result
  } catch {
    return null
  }
}

function writeCache(result: FetchResult): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const cached: CachedResult = { timestamp: Date.now(), result }
    writeFileSync(CACHE_FILE, JSON.stringify(cached), "utf8")
  } catch {}
}

/**
 * Fetch Claude usage data via 4-step fallback chain:
 * 1. OAuth API (only if user:profile scope available)
 * 2. Claude CLI PTY probe (primary for most users)
 * 3. Browser cookies (Chrome/Firefox)
 * 4. Failure → authMethod "none"
 *
 * Never throws. Always returns a FetchResult.
 */
export async function fetchUsageData(): Promise<FetchResult> {
  // ── Step 0: Environment variable token (works on all OS) ────────────
  try {
    const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (envToken) {
      const [usage, profile] = await Promise.all([
        fetchOAuthUsage(envToken),
        fetchOAuthProfile(envToken),
      ])
      if (usage) {
        return { usage, profile, authMethod: "oauth" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 1: Credentials file (~/.claude/.credentials.json, cross-platform)
  try {
    const fileCreds = readCredentialsFile()
    if (fileCreds) {
      const [usage, profile] = await Promise.all([
        fetchOAuthUsage(fileCreds.accessToken),
        fetchOAuthProfile(fileCreds.accessToken),
      ])
      if (usage) {
        return { usage, profile, authMethod: "oauth" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 2: OpenCode auth.json + token refresh (cross-platform)
  try {
    const ocAuth = readOpenCodeAuth()
    if (ocAuth) {
      let token = ocAuth.accessToken
      if (isTokenExpired(ocAuth.expiresAt) && ocAuth.refreshToken) {
        const refreshed = await refreshToken(ocAuth.refreshToken)
        if (refreshed) token = refreshed.accessToken
      }
      const [usage, profile] = await Promise.all([
        fetchOAuthUsage(token),
        fetchOAuthProfile(token),
      ])
      if (usage) {
        return { usage, profile, authMethod: "oauth" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 3: Keychain (macOS only)
  try {
    const credentials = await readKeychainCredentials()
    if (credentials?.hasProfileScope) {
      const [usage, profile] = await Promise.all([
        fetchOAuthUsage(credentials.accessToken),
        fetchOAuthProfile(credentials.accessToken),
      ])
      if (usage) {
        return { usage, profile, authMethod: "oauth" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 2: CLI PTY probe (primary for most users) ──────────────────
  try {
    const installed = await detectClaude()
    if (installed) {
      const [probeResult, statusResult] = await Promise.all([
        probeCLIUsage(),
        probeStatus(),
      ])

      if (probeResult) {
        // Map CLIProbeResult → OAuthUsageResponse (best-effort)
        const usage: OAuthUsageResponse = {
          fiveHour: probeResult.sessionPercent !== null
            ? { utilization: probeResult.sessionPercent, resetsAt: probeResult.sessionReset }
            : null,
          sevenDay: probeResult.weeklyPercent !== null
            ? { utilization: probeResult.weeklyPercent, resetsAt: probeResult.weeklyReset }
            : null,
          sevenDaySonnet: probeResult.sonnetPercent !== null
            ? { utilization: probeResult.sonnetPercent, resetsAt: null }
            : null,
          sevenDayOpus: probeResult.opusPercent !== null
            ? { utilization: probeResult.opusPercent, resetsAt: null }
            : null,
          sevenDayDesign: null,
          sevenDayRoutines: null,
          sevenDayOAuthApps: null,
          extraUsage: null,
        }

        const profile: ProfileResponse | null = statusResult
          ? {
              email: statusResult.email,
              plan: statusResult.org,
            }
          : null

        return { usage, profile, authMethod: "cli" }
      }
    }
  } catch {
    // continue
  }

  // ── Step 3: Browser cookies ──────────────────────────────────────────
  try {
    const sessionKey = await extractSessionKey()
    if (sessionKey) {
      const usage = await fetchWebUsage(sessionKey)
      if (usage) {
        return { usage, profile: null, authMethod: "cookie" }
      }
    }
  } catch {
    // continue
  }

  // ── All failed ───────────────────────────────────────────────────────
  return { usage: null, profile: null, authMethod: "none" }
}


/**
 * Create a refresh loop that calls fetchUsageData() on an interval.
 * Prevents duplicate concurrent fetches with a refreshing flag.
 * Preserves stale data during loading to prevent UI flicker.
 */
export function createRefreshLoop(
  setState: (state: UsageState) => void,
  intervalMs: number,
): { start: () => void; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null
  let refreshing = false
  let lastData: UsageState["data"] = null
  let lastProfile: UsageState["profile"] = null
  let lastAuthMethod: UsageState["authMethod"] = "none"
  let isFirstRun = true

  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true

    if (isFirstRun) {
      const cached = readCache()
      if (cached && cached.usage) {
        lastData = cached.usage
        lastProfile = cached.profile
        lastAuthMethod = cached.authMethod
        setState({
          status: "success",
          data: cached.usage,
          profile: cached.profile,
          authMethod: cached.authMethod,
          error: null,
        })
      }
    }

    if (!lastData) {
      setState({
        status: "loading",
        data: null,
        profile: null,
        authMethod: "none",
        error: null,
      })
    }

    try {
      const result = await fetchUsageData()

      if (result.authMethod === "none") {
        if (lastData) {
          setState({
            status: "success",
            data: lastData,
            profile: lastProfile,
            authMethod: lastAuthMethod,
            error: null,
          })
        } else {
          lastData = null
          lastProfile = null
          lastAuthMethod = "none"
          setState({
            status: "not-configured",
            data: null,
            profile: null,
            authMethod: "none",
            error: null,
          })
        }
      } else {
        lastData = result.usage
        lastProfile = result.profile
        lastAuthMethod = result.authMethod
        writeCache(result)
        setState({
          status: "success",
          data: result.usage,
          profile: result.profile,
          authMethod: result.authMethod,
          error: null,
        })
      }
    } catch (err) {
      setState({
        status: "error",
        data: null,
        profile: null,
        authMethod: "none",
        error: String(err),
      })
    } finally {
      refreshing = false
      isFirstRun = false
    }
  }

  return {
    start() {
      // Initial fetch immediately
      void refresh()
      timer = setInterval(() => { void refresh() }, intervalMs)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
