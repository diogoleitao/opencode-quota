import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "os";
import { join } from "path";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: [join(homedir(), ".local", "share", "opencode")],
    configDirs: [join(homedir(), ".config", "opencode")],
    cacheDirs: [join(homedir(), ".cache", "opencode")],
    stateDirs: [join(homedir(), ".local", "state", "opencode")],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: join(homedir(), ".local", "share", "opencode"),
    configDir: join(homedir(), ".config", "opencode"),
    cacheDir: join(homedir(), ".cache", "opencode"),
    stateDir: join(homedir(), ".local", "state", "opencode"),
  }),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(),
  getAuthPaths: () => [join(homedir(), ".local", "share", "opencode", "auth.json")],
}));

describe("nanogpt-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.NANOGPT_API_KEY;
    delete process.env.NANO_GPT_API_KEY;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveNanoGptApiKey", () => {
    it("returns env var NANOGPT_API_KEY when set", async () => {
      process.env.NANOGPT_API_KEY = "env-key-1";

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "env-key-1",
        source: "env:NANOGPT_API_KEY",
      });
    });

    it("returns env var NANO_GPT_API_KEY when NANOGPT_API_KEY is not set", async () => {
      process.env.NANO_GPT_API_KEY = "env-key-2";

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "env-key-2",
        source: "env:NANO_GPT_API_KEY",
      });
    });

    it("reads from trusted global opencode.json provider.nanogpt", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) =>
        path === join(homedir(), ".config", "opencode", "opencode.json"),
      );
      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            nanogpt: {
              options: {
                apiKey: "json-api-key",
              },
            },
          },
        }),
      );

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "json-api-key",
        source: "opencode.json",
      });
    });

    it("reads from trusted global opencode.jsonc provider.nano-gpt", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");

      (existsSync as any).mockImplementation((path: string) =>
        path === join(homedir(), ".config", "opencode", "opencode.jsonc"),
      );
      (readFile as any).mockResolvedValue(`{
        "provider": {
          "nano-gpt": {
            "options": {
              "apiKey": "jsonc-api-key"
            }
          }
        }
      }`);

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "jsonc-api-key",
        source: "opencode.jsonc",
      });
    });

    it("rejects arbitrary env-template names in trusted config", async () => {
      const { existsSync } = await import("fs");
      const { readFile } = await import("fs/promises");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockImplementation((path: string) =>
        path === join(homedir(), ".config", "opencode", "opencode.json"),
      );
      (readFile as any).mockResolvedValue(
        JSON.stringify({
          provider: {
            nanogpt: {
              options: {
                apiKey: "{env:SOMETHING_ELSE}",
              },
            },
          },
        }),
      );
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toBeNull();
    });

    it("ignores workspace-local opencode.json when resolving provider secrets", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      const workspacePath = join(process.cwd(), "opencode.json");
      (existsSync as any).mockImplementation((path: string) => path === workspacePath);
      (readAuthFile as any).mockResolvedValue(null);

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toBeNull();
    });

    it("falls back to auth.json for nanogpt and nano-gpt keys", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");

      (existsSync as any).mockReturnValue(false);
      (readAuthFile as any).mockResolvedValueOnce({
        nanogpt: {
          type: "api",
          key: "auth-key-1",
        },
      });

      const { resolveNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(resolveNanoGptApiKey()).resolves.toEqual({
        key: "auth-key-1",
        source: "auth.json",
      });

      vi.resetModules();
      vi.clearAllMocks();

      const fsAgain = await import("fs");
      const authAgain = await import("../src/lib/opencode-auth.js");
      (fsAgain.existsSync as any).mockReturnValue(false);
      (authAgain.readAuthFile as any).mockResolvedValueOnce({
        "nano-gpt": {
          type: "api",
          key: "auth-key-2",
        },
      });

      const reload = await import("../src/lib/nanogpt-config.js");
      await expect(reload.resolveNanoGptApiKey()).resolves.toEqual({
        key: "auth-key-2",
        source: "auth.json",
      });
    });
  });

  describe("hasNanoGptApiKey", () => {
    it("returns true when a key is configured", async () => {
      process.env.NANOGPT_API_KEY = "test-key";

      const { hasNanoGptApiKey } = await import("../src/lib/nanogpt-config.js");
      await expect(hasNanoGptApiKey()).resolves.toBe(true);
    });
  });

  describe("getNanoGptKeyDiagnostics", () => {
    it("returns configured diagnostics with source and env path", async () => {
      process.env.NANOGPT_API_KEY = "diag-key";

      const { getNanoGptKeyDiagnostics } = await import("../src/lib/nanogpt-config.js");
      const result = await getNanoGptKeyDiagnostics();

      expect(result.configured).toBe(true);
      expect(result.source).toBe("env:NANOGPT_API_KEY");
      expect(result.checkedPaths).toContain("env:NANOGPT_API_KEY");
      expect(result.authPaths).toContain(join(homedir(), ".local", "share", "opencode", "auth.json"));
    });

    it("reports checked trusted config paths", async () => {
      const { existsSync } = await import("fs");
      const { readAuthFile } = await import("../src/lib/opencode-auth.js");
      const expectedPath = join(homedir(), ".config", "opencode", "opencode.json");

      (existsSync as any).mockImplementation((path: string) => path === expectedPath);
      (readAuthFile as any).mockResolvedValue(null);

      const { getNanoGptKeyDiagnostics } = await import("../src/lib/nanogpt-config.js");
      const result = await getNanoGptKeyDiagnostics();

      expect(result.configured).toBe(false);
      expect(result.checkedPaths).toContain(expectedPath);
      expect(result.authPaths).toContain(join(homedir(), ".local", "share", "opencode", "auth.json"));
    });
  });

  describe("getOpencodeConfigCandidatePaths", () => {
    it("returns trusted global paths only", async () => {
      const { getOpencodeConfigCandidatePaths } = await import("../src/lib/nanogpt-config.js");
      const paths = getOpencodeConfigCandidatePaths();

      expect(paths).toHaveLength(2);
      expect(paths[0].isJsonc).toBe(true);
      expect(paths[1].isJsonc).toBe(false);
      expect(paths[0].path).toContain("opencode");
      expect(paths[1].path).toContain("opencode");
    });
  });
});
