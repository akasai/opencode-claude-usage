import { execFile, spawn } from "node:child_process"
import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CLIProbeResult } from "./types.js"

const PROBE_TIMEOUT_MS = 25_000
const DETECT_TIMEOUT_MS = 5_000

let claudeDetected: boolean | null = null
let python3Detected: boolean | null = null

export function detectClaude(): Promise<boolean> {
  if (claudeDetected === true) return Promise.resolve(true)
  return new Promise((resolve) => {
    execFile("which", ["claude"], { timeout: DETECT_TIMEOUT_MS }, (err, stdout) => {
      claudeDetected = !err && stdout.trim().length > 0
      resolve(claudeDetected)
    })
  })
}

export function detectPython3(): Promise<boolean> {
  if (python3Detected === true) return Promise.resolve(true)
  return new Promise((resolve) => {
    execFile("which", ["python3"], { timeout: DETECT_TIMEOUT_MS }, (err, stdout) => {
      python3Detected = !err && stdout.trim().length > 0
      resolve(python3Detected)
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


/**
 * Python3 PTY wrapper: creates a real PTY pair via pty.openpty(), forks the
 * claude process into it, sends /usage after startup, reads TUI output.
 * macOS `script` command fails with piped stdio — Python3 pty avoids this.
 */
function buildPtyScript(claudeBinary: string): string {
  if (/["\\'\n\r]/.test(claudeBinary)) {
    throw new Error("Unsafe claude binary path")
  }
  return `
import pty, os, sys, select, time, signal, re

STOP_NEEDLES = ["current session", "current week", "failed to load usage data"]
STARTUP_DELAY = 1.5
ENTER_EVERY = 0.5
SETTLE_DELAY = 1.0
TIMEOUT = 20.0
ANSI_RE = re.compile(chr(27) + r'\[[0-9;]*[a-zA-Z]|' + chr(27) + r'\][^' + chr(7) + r']*' + chr(7))

def strip_ansi(data):
    return ANSI_RE.sub('', data.decode('utf-8', errors='replace'))

def normalize(data):
    return strip_ansi(data).lower().replace(' ', '')

fd_primary, fd_secondary = pty.openpty()
pid = os.fork()

if pid == 0:
    os.setsid()
    os.dup2(fd_secondary, 0)
    os.dup2(fd_secondary, 1)
    os.dup2(fd_secondary, 2)
    os.close(fd_primary)
    os.close(fd_secondary)
    os.execve("${claudeBinary}", ["${claudeBinary}"], os.environ)
    sys.exit(1)

os.close(fd_secondary)
buf = b""
start = time.time()
command_sent = False
last_enter = 0.0
settled = False
settle_start = 0.0

try:
    while True:
        elapsed = time.time() - start
        if elapsed > TIMEOUT:
            break

        if not command_sent and elapsed >= STARTUP_DELAY:
            try:
                os.write(fd_primary, b"/usage" + bytes([13]))
                command_sent = True
                last_enter = time.time()
            except OSError:
                break

        if command_sent and not settled and (time.time() - last_enter) >= ENTER_EVERY:
            try:
                os.write(fd_primary, bytes([13]))
                last_enter = time.time()
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
            normalized = normalize(buf)
            for needle in STOP_NEEDLES:
                if needle in normalized:
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
    const tmpFile = join(tmpdir(), `claude-probe-${process.pid}.py`)
    writeFileSync(tmpFile, script, "utf8")
    const proc = spawn("python3", [tmpFile], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    const chunks: Uint8Array[] = []
    proc.stdout?.on("data", (chunk: Uint8Array) => chunks.push(chunk))

    const cleanup = () => { try { unlinkSync(tmpFile) } catch {} }

    const timer = setTimeout(() => {
      proc.kill("SIGTERM")
      cleanup()
      resolve(null)
    }, PROBE_TIMEOUT_MS)

    proc.on("close", () => {
      clearTimeout(timer)
      cleanup()
      const output = Buffer.concat(chunks).toString("utf8")
      resolve(output.length > 0 ? output : null)
    })

    proc.on("error", () => {
      clearTimeout(timer)
      cleanup()
      resolve(null)
    })
  })
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "")
}

function trimToLatestUsagePanel(clean: string): string {
  const lower = clean.toLowerCase()
  const settingsIdx = lower.lastIndexOf("settings:")
  if (settingsIdx < 0) return clean
  const tail = clean.slice(settingsIdx)
  if (!tail.toLowerCase().includes("usage")) return clean
  if (tail.includes("%") && (tail.toLowerCase().includes("used") || tail.toLowerCase().includes("left"))) {
    return tail
  }
  return clean
}

function percentFromLine(line: string): number | null {
  if (line.includes("|") && /opus|sonnet|haiku|default/i.test(line)) return null
  const match = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/)
  if (!match) return null
  const rawVal = Math.max(0, Math.min(100, Number.parseFloat(match[1])))
  const lower = line.toLowerCase()
  if (["used", "spent", "consumed"].some((kw) => lower.includes(kw))) {
    return Math.round(rawVal)
  }
  if (["left", "remaining", "available"].some((kw) => lower.includes(kw))) {
    return Math.round(100 - rawVal)
  }
  return null
}

function extractPercentByLabel(lines: string[], label: string): number | null {
  const normalizedLabel = normalize(label)
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]).includes(normalizedLabel)) {
      for (let j = i; j < Math.min(i + 12, lines.length); j++) {
        const pct = percentFromLine(lines[j])
        if (pct !== null) return pct
      }
    }
  }
  return null
}

function extractResetByLabel(lines: string[], label: string): string | null {
  const normalizedLabel = normalize(label)
  for (let i = 0; i < lines.length; i++) {
    if (normalize(lines[i]).includes(normalizedLabel)) {
      for (let j = i; j < Math.min(i + 14, lines.length); j++) {
        const lower = lines[j].toLowerCase()
        const resetIdx = lower.indexOf("resets")
        if (resetIdx >= 0) {
          return lines[j].slice(resetIdx).replace(/[\r\n]+/g, "").trim()
        }
      }
    }
  }
  return null
}

function parseUsageOutput(rawOutput: string): Partial<CLIProbeResult> {
  const clean = stripAnsiCodes(rawOutput)
  const panel = trimToLatestUsagePanel(clean)
  const lines = panel.split("\n")

  let sessionPercent = extractPercentByLabel(lines, "Current session")
  let weeklyPercent = extractPercentByLabel(lines, "Current week (all models)") ??
    extractPercentByLabel(lines, "Current week")
  const opusPercent = extractPercentByLabel(lines, "Current week (Opus)")
  const sonnetPercent = extractPercentByLabel(lines, "Current week (Sonnet)")

  const sessionReset = extractResetByLabel(lines, "Current session")
  const weeklyReset = extractResetByLabel(lines, "Current week (all models)") ??
    extractResetByLabel(lines, "Current week")

  if (sessionPercent === null || weeklyPercent === null) {
    const ordered = lines.map(percentFromLine).filter((v): v is number => v !== null)
    if (sessionPercent === null && ordered.length > 0) sessionPercent = ordered[0]
    if (weeklyPercent === null && ordered.length > 1) weeklyPercent = ordered[1]
  }

  return { sessionPercent, weeklyPercent, opusPercent, sonnetPercent, sessionReset, weeklyReset }
}

export async function probeCLIUsage(): Promise<CLIProbeResult | null> {
  try {
    const [installed, hasPython] = await Promise.all([detectClaude(), detectPython3()])
    if (!installed || !hasPython) return null

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
      sessionReset: parsed.sessionReset ?? null,
      weeklyReset: parsed.weeklyReset ?? null,
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
