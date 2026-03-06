import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  readAuthFile: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
  };
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: ["/home/test/.config/opencode"],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  }),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: authMocks.readAuthFile,
}));

const patPath = "/home/test/.config/opencode/copilot-quota-token.json";
const realEnv = process.env;

describe("queryCopilotQuota", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    process.env = { ...realEnv };
    fsMocks.existsSync.mockReset();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReset();
    authMocks.readAuthFile.mockReset();
    authMocks.readAuthFile.mockResolvedValue({});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })) as any);
  });

  afterEach(() => {
    process.env = realEnv;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null when no PAT config and no OpenCode Copilot auth exist", async () => {
    const { queryCopilotQuota } = await import("../src/lib/copilot.js");

    await expect(queryCopilotQuota()).resolves.toBeNull();
  });

  it("prefers PAT billing config over OpenCode auth when both exist", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
        username: "alice",
      }),
    );
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/users/alice/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 42,
                limit: 300,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      used: 42,
      total: 300,
      percentRemaining: 85,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/users/alice/settings/billing/premium_request/usage",
    );
  });

  it("uses OpenCode auth against the documented user billing endpoint when PAT is absent", async () => {
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot-chat": { type: "oauth", access: "oauth_access_token" },
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.endsWith("/user")) {
        return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      }

      if (target.includes("/users/octocat/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 12,
                limit: 300,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      used: 12,
      total: 300,
      percentRemaining: 96,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/users/octocat/settings/billing/premium_request/usage",
    ]);
  });

  it("does not fall back to OpenCode auth when PAT config is invalid", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ token: "github_pat_123456789" }));
    authMocks.readAuthFile.mockResolvedValueOnce({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "Invalid copilot-quota-token.json",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("errors when business tier config omits organization", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
      }),
    );

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      'Add "organization": "your-org-slug"',
    );
  });

  it("uses the documented organization billing endpoint when organization is configured", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (
        target ===
        "https://api.github.com/organizations/acme-corp/settings/billing/premium_request/usage?user=alice"
      ) {
        return new Response(
          JSON.stringify({
            organization: "acme-corp",
            usageItems: [
              {
                sku: "Copilot Premium Request",
                grossQuantity: 9,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      used: 9,
      total: 300,
      percentRemaining: 97,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/organizations/acme-corp/settings/billing/premium_request/usage?user=alice",
    );
  });

  it("handles snake_case billing response fields", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/users/alice/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usage_items: [
              {
                sku: "Copilot Premium Request",
                gross_quantity: 9,
                limit: 300,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result).toEqual({
      success: true,
      used: 9,
      total: 300,
      percentRemaining: 97,
      resetTimeIso: "2026-02-01T00:00:00.000Z",
    });
  });

  it("errors when billing response contains no premium request SKU", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "pro",
        username: "alice",
      }),
    );

    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url);

      if (target.includes("/users/alice/settings/billing/premium_request/usage")) {
        return new Response(
          JSON.stringify({
            usageItems: [
              {
                sku: "Some Other SKU",
                grossQuantity: 5,
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    });

    vi.stubGlobal("fetch", fetchMock as any);

    const { queryCopilotQuota } = await import("../src/lib/copilot.js");
    const result = await queryCopilotQuota();

    expect(result && !result.success ? result.error : "").toContain(
      "No premium-request items found",
    );
  });

  it("surfaces PAT precedence and organization details in diagnostics", async () => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        token: "github_pat_123456789",
        tier: "business",
        organization: "acme-corp",
      }),
    );

    const { getCopilotQuotaAuthDiagnostics } = await import("../src/lib/copilot.js");
    const diagnostics = getCopilotQuotaAuthDiagnostics({
      "github-copilot": { type: "oauth", access: "oauth_access_token" },
    });

    expect(diagnostics.pat.state).toBe("valid");
    expect(diagnostics.pat.config?.organization).toBe("acme-corp");
    expect(diagnostics.oauth.configured).toBe(true);
    expect(diagnostics.effectiveSource).toBe("pat");
    expect(diagnostics.override).toBe("pat_overrides_oauth");
  });
});
