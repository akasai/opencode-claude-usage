import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFile } from "node:child_process"
import { readKeychainCredentials } from "../keychain.js"

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

const mockExecFile = vi.mocked(execFile)
const originalPlatform = process.platform

function mockPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  })
}

describe("readKeychainCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPlatform("darwin")
  })

  afterEach(() => {
    mockPlatform(originalPlatform)
  })

  it("returns null when security CLI fails", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(new Error("not found"), "", "")
      return {} as any
    })
    const result = await readKeychainCredentials()
    expect(result).toBeNull()
  })

  it("returns null when JSON is malformed", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, "not-json", "")
      return {} as any
    })
    const result = await readKeychainCredentials()
    expect(result).toBeNull()
  })

  it("parses credentials and sets hasProfileScope correctly", async () => {
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test",
        refreshToken: "sk-ant-ort01-test",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "default",
      },
    })
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      (cb as Function)(null, payload, "")
      return {} as any
    })
    const result = await readKeychainCredentials()
    expect(result).not.toBeNull()
    expect(result?.accessToken).toBe("sk-ant-oat01-test")
    expect(result?.hasProfileScope).toBe(false)
  })

  it("returns null without shelling out on non-macOS platforms", async () => {
    mockPlatform("linux")

    const result = await readKeychainCredentials()

    expect(result).toBeNull()
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
