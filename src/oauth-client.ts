import type { OAuthUsageResponse, ProfileResponse } from "./types"

const BASE_URL = "https://api.anthropic.com"
const BETA_HEADER = "oauth-2025-04-20"
const USER_AGENT = "claude-code/2.1.0"
const TIMEOUT_MS = 10_000

function makeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "anthropic-beta": BETA_HEADER,
    "User-Agent": USER_AGENT,
  }
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    return response
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Recursively convert snake_case keys to camelCase.
 * e.g. five_hour → fiveHour, resets_at → resetsAt
 */
export function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(snakeToCamel)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      result[camelKey] = snakeToCamel(value)
    }
    return result
  }
  return obj
}

/**
 * Fetch Claude usage data via OAuth API.
 * Requires user:profile scope — returns null on 401/403.
 */
export async function fetchOAuthUsage(accessToken: string): Promise<OAuthUsageResponse | null> {
  try {
    const response = await fetchWithTimeout(
      `${BASE_URL}/api/oauth/usage`,
      makeHeaders(accessToken),
    )
    if (!response || !response.ok) return null

    const raw = await response.json() as Record<string, unknown>
    return snakeToCamel(raw) as OAuthUsageResponse
  } catch {
    return null
  }
}

export async function fetchOAuthProfile(accessToken: string): Promise<ProfileResponse | null> {
  try {
    const response = await fetchWithTimeout(
      `${BASE_URL}/api/oauth/profile`,
      makeHeaders(accessToken),
    )
    if (!response || !response.ok) return null

    const raw = await response.json() as Record<string, unknown>
    const converted = snakeToCamel(raw) as Record<string, unknown>

    const email = typeof converted.email === "string" ? converted.email : null
    if (!email) return null

    return {
      email,
      plan: typeof converted.subscriptionType === "string" ? converted.subscriptionType : null,
    }
  } catch {
    return null
  }
}
