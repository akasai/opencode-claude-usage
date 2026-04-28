import { execFile, spawn } from "node:child_process"
import type { CLIProbeResult } from "./types.js"

const PROBE_TIMEOUT_MS = 20_000
const DETECT_TIMEOUT_MS = 5_000

let claudeDetected: boolean | null = null

export function detectClaude(): Promise<boolean> {
  if (claudeDetected !== null) return Promise.resolve(claudeDetected)
  return new Promise((resolve) => {
    execFile("which", ["claude"], { timeout: DETECT_TIMEOUT_MS }, (err, stdout) => {
      claudeDetected = !err && stdout.trim().length > 0
      resolve(claudeDetected)
    })
  })
}

export function stripAnsiCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
}

export function extractPercent(text: string, label: string): number | null {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(label.toLowerCase())) {
      for (let j = i; j < Math.min(i + 4, lines.length); j++) {
        const match = lines[j].match(/(\d{1,3}(?:\.\d+)?)\s*%/)
        if (match) return Number.parseFloat(match[1])
      }
    }
  }
  return null
}

function allPercents(text: string): number[] {
  const matches = text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)
  return [...matches].map((m) => Number.parseFloat(m[1]))
}

/**
 * Python3 PTY wrapper: creates a real PTY pair via pty.openpty(), forks the
 * claude process into it, sends /usage after startup, reads TUI output.
 * macOS `script` command fails with piped stdio — Python3 pty avoids this.
 */
function buildPtyScript(claudeBinary: string): string {
  return `
import pty, os, sys, select, time, signal

STOP_NEEDLES = [b"Current session", b"Current week", b"Failed to load usage data"]
STARTUP_DELAY = 3.0
SETTLE_DELAY = 2.0
TIMEOUT = 18.0

fd_primary, fd_secondary = pty.openpty()
pid = os.fork()

if pid == 0:
    os.setsid()
    os.dup2(fd_secondary, 0)
    os.dup2(fd_secondary, 1)
    os.dup2(fd_secondary, 2)
    os.close(fd_primary)
    os.close(fd_secondary)
    os.execvp("${claudeBinary}", ["${claudeBinary}"])
    sys.exit(1)

os.close(fd_secondary)
buf = b""
start = time.time()
command_sent = False
settled = False
settle_start = 0.0

try:
    while True:
        elapsed = time.time() - start
        if elapsed > TIMEOUT:
            break

        if not command_sent and elapsed >= STARTUP_DELAY:
            try:
                os.write(fd_primary, b"/usage\\n")
                command_sent = True
            except OSError:
                break

        try:
            r, _, _ = select.select([fd_primary], [], [], 0.1)
            if r:
                data = os.read(fd_primary, 4096)
                buf += data
        except OSError:
            break

        if command_sent and not settled:
            for needle in STOP_NEEDLES:
                if needle in buf:
                    settled = True
                    settle_start = time.time()
                    break

        if settled and (time.time() - settle_start) >= SETTLE_DELAY:
            break

finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    os.close(fd_primary)

sys.stdout.buffer.write(buf)
sys.stdout.buffer.flush()
`
}

function runPtyProbe(claudeBinary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const script = buildPtyScript(claudeBinary)
    const proc = spawn("python3", ["-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    const chunks: Uint8Array[] = []
    proc.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk))

    const timer = setTimeout(() => {
      proc.kill("SIGTERM")
      resolve(null)
    }, PROBE_TIMEOUT_MS)

    proc.on("close", () => {
      clearTimeout(timer)
      const output = Buffer.concat(chunks).toString("utf8")
      resolve(output.length > 0 ? output : null)
    })

    proc.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function parseUsageOutput(rawOutput: string): Partial<CLIProbeResult> {
  const clean = stripAnsiCodes(rawOutput)

  const lastPanel = (() => {
    const idx = clean.lastIndexOf("Current session")
    return idx >= 0 ? clean.slice(idx) : clean
  })()

  let sessionPercent = extractPercent(lastPanel, "Current session")
  let weeklyPercent = extractPercent(lastPanel, "Current week (all models)")
  const opusPercent =
    extractPercent(lastPanel, "Current week (Opus)") ??
    extractPercent(lastPanel, "Current week (Sonnet only)")
  const sonnetPercent = extractPercent(lastPanel, "Current week (Sonnet)")

  const ordered = allPercents(lastPanel)
  if (sessionPercent === null && ordered.length > 0) sessionPercent = ordered[0]
  if (weeklyPercent === null && ordered.length > 1) weeklyPercent = ordered[1]

  // CLI shows "remaining" %; OAuthUsageResponse uses "used" % — stored as-is,
  // renderer labels accordingly
  return { sessionPercent, weeklyPercent, opusPercent, sonnetPercent }
}

export async function probeCLIUsage(): Promise<CLIProbeResult | null> {
  try {
    const installed = await detectClaude()
    if (!installed) return null

    const claudeBinary = await new Promise<string>((resolve) => {
      execFile("which", ["claude"], (_, stdout) => resolve(stdout.trim()))
    })

    const rawOutput = await runPtyProbe(claudeBinary)
    if (!rawOutput) return null

    const parsed = parseUsageOutput(rawOutput)

    if (parsed.sessionPercent === null && parsed.weeklyPercent === null) return null

    return {
      sessionPercent: parsed.sessionPercent ?? null,
      weeklyPercent: parsed.weeklyPercent ?? null,
      opusPercent: parsed.opusPercent ?? null,
      sonnetPercent: parsed.sonnetPercent ?? null,
      email: null,
      org: null,
    }
  } catch {
    return null
  }
}

export function probeStatus(): Promise<{ email: string; org: string | null } | null> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status"], { timeout: 10_000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      try {
        const data = JSON.parse(stdout) as Record<string, unknown>
        const email = typeof data.email === "string" ? data.email : null
        if (!email) {
          resolve(null)
          return
        }
        const org = typeof data.orgName === "string" ? data.orgName : null
        resolve({ email, org })
      } catch {
        resolve(null)
      }
    })
  })
}
