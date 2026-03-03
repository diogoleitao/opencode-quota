import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function createBootstrapSnapshot(generatedAt: number) {
  return {
    _meta: {
      source: "test-bootstrap",
      generatedAt,
      providers: ["openai"],
      units: "USD per 1M tokens",
    },
    providers: {
      openai: {
        "gpt-4o-mini": {
          input: 0.15,
          output: 0.6,
          cache_read: 0.03,
          cache_write: 0.2,
        },
      },
    },
  };
}

function createRuntimeDirs(root: string): OpencodeRuntimeDirs {
  return {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createTempRuntimeDirs(): Promise<OpencodeRuntimeDirs> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-pricing-"));
  tempRoots.push(root);
  return createRuntimeDirs(root);
}

async function loadPricingModule() {
  vi.resetModules();
  return await import("../src/lib/modelsdev-pricing.js");
}

describe("pricing runtime refresh policy", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCODE_QUOTA_PRICING_AUTO_REFRESH", "1");
  });

  it("does not fetch when snapshot is fresh", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const fetchFn = vi.fn();

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches and persists a runtime snapshot when stale", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": {
                cost: {
                  input: 0.123,
                  output: 0.456,
                  cache_read: 0.01,
                  cache_write: 0.02,
                  reasoning: 999,
                  ignored_key: 123,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            etag: "etag-1",
            "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT",
          },
        },
      ),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    expect(await exists(runtimeSnapshotPath)).toBe(true);

    const persistedSnapshot = JSON.parse(await readFile(runtimeSnapshotPath, "utf-8"));
    expect(persistedSnapshot._meta.generatedAt).toBe(nowMs);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"]).toEqual({
      input: 0.123,
      output: 0.456,
      cache_read: 0.01,
      cache_write: 0.02,
    });
  });

  it("falls back to last local snapshot when fetch fails", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.error).toContain("network down");

    const fallbackCost = pricing.lookupCost("openai", "gpt-4o-mini");
    expect(fallbackCost?.input).toBe(0.15);

    const state = await pricing.readPricingRefreshState(runtimeDirs);
    expect(state?.lastResult).toBe("failed");
    expect(state?.lastError).toContain("network down");
  });

  it("uses bundled bootstrap snapshot when no runtime snapshot exists", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn: vi.fn(),
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.output).toBe(0.6);

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    expect(await exists(runtimeSnapshotPath)).toBe(false);
  });

  it("refreshes local snapshot freshness when models.dev responds 304", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: {
          etag: "etag-304",
          "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT",
        },
      }),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.state.lastResult).toBe("not_modified");
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.getPricingSnapshotMeta().generatedAt).toBe(nowMs);

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    const persistedSnapshot = JSON.parse(await readFile(runtimeSnapshotPath, "utf-8"));
    expect(persistedSnapshot._meta.generatedAt).toBe(nowMs);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"].input).toBe(0.15);
  });

  it("throttles refresh attempts using persisted lastAttemptAt state", async () => {
    const firstLoad = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const failingFetch = vi.fn().mockRejectedValue(new Error("network down"));
    const firstResult = await firstLoad.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn: failingFetch,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(firstResult.attempted).toBe(true);
    expect(firstResult.updated).toBe(false);

    const secondLoad = await loadPricingModule();
    const throttledFetch = vi.fn();
    const secondResult = await secondLoad.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 60_000,
      runtimeDirs,
      fetchFn: throttledFetch,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(secondResult.attempted).toBe(false);
    expect(secondResult.reason).toBe("throttled");
    expect(throttledFetch).not.toHaveBeenCalled();
  });

  it("dedupes concurrent attempts and only checks once per process window", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    const second = pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    resolveFetch?.(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": {
                cost: { input: 0.2, output: 0.8 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.updated).toBe(true);
    expect(secondResult.updated).toBe(true);

    const thirdResult = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 30_000,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(thirdResult.attempted).toBe(false);
    expect(thirdResult.reason).toBe("already_checked_this_process");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
