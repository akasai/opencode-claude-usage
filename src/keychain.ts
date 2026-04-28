import { execFile } from "node:child_process"
import type { OAuthCredentials, KeychainPayload } from "./types.js"

const KEYCHAIN_SERVICE = "Claude Code-credentials"
const PROFILE_SCOPE = "user:profile"
// Expire 5 minutes early to avoid using almost-expired tokens
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

/**
 * Check if a Unix timestamp (ms) is expired, with a 5-minute buffer.
 */
export function isTokenExpired(expiresAtMs: number): boolean {
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAtMs
}

/**
 * Read Claude CLI OAuth credentials from macOS Keychain.
 * Returns null if credentials are missing, expired, or access is denied.
 * Never throws — always returns null on error.
 */
export function readKeychainCredentials(): Promise<OAuthCredentials | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null)
          return
        }

        try {
          const raw = stdout.trim()
          const payload = JSON.parse(raw) as KeychainPayload
          const inner = payload.claudeAiOauth

          if (!inner || !inner.accessToken) {
            resolve(null)
            return
          }

          if (isTokenExpired(inner.expiresAt)) {
            resolve(null)
            return
          }

          const credentials: OAuthCredentials = {
            accessToken: inner.accessToken,
            refreshToken: inner.refreshToken,
            expiresAt: inner.expiresAt,
            scopes: inner.scopes ?? [],
            subscriptionType: inner.subscriptionType ?? null,
            rateLimitTier: inner.rateLimitTier ?? null,
            hasProfileScope: (inner.scopes ?? []).includes(PROFILE_SCOPE),
          }

          resolve(credentials)
        } catch {
          resolve(null)
        }
      },
    )
  })
}
