import { readFileSync } from "fs";

export type CostBuckets = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

type Snapshot = {
  _meta: {
    source: string;
    generatedAt: number;
    providers: string[];
    units: string;
  };
  providers: Record<string, Record<string, CostBuckets>>;
};

let SNAPSHOT: Snapshot | null = null;
let MODEL_INDEX: Map<string, string[]> | null = null;

function ensureLoaded(): Snapshot {
  if (SNAPSHOT) return SNAPSHOT;
  const url = new URL("../data/modelsdev-pricing.min.json", import.meta.url);
  const raw = readFileSync(url, "utf-8");
  SNAPSHOT = JSON.parse(raw) as Snapshot;
  return SNAPSHOT;
}

function ensureModelIndex(): Map<string, string[]> {
  if (MODEL_INDEX) return MODEL_INDEX;
  const snap = ensureLoaded();
  const idx = new Map<string, string[]>();

  for (const providerId of Object.keys(snap.providers)) {
    const models = snap.providers[providerId] ?? {};
    for (const modelId of Object.keys(models)) {
      const existing = idx.get(modelId);
      if (existing) existing.push(providerId);
      else idx.set(modelId, [providerId]);
    }
  }

  MODEL_INDEX = idx;
  return idx;
}

export function getPricingSnapshotMeta(): Snapshot["_meta"] {
  return ensureLoaded()._meta;
}

export function hasProvider(providerId: string): boolean {
  return !!ensureLoaded().providers[providerId];
}

export function isModelsDevProviderId(providerId: string): boolean {
  return hasProvider(providerId);
}

export function hasModel(providerId: string, modelId: string): boolean {
  const p = ensureLoaded().providers[providerId];
  if (!p) return false;
  return !!p[modelId];
}

/**
 * Infer the snapshot provider that owns a modelId.
 * Returns null when model is not found or is ambiguous across providers.
 */
export function inferProviderForModelId(modelId: string): string | null {
  const providers = listProvidersForModelId(modelId);
  if (!providers || providers.length !== 1) return null;
  return providers[0] ?? null;
}

export function getProviderModelCount(providerId: string): number {
  return Object.keys(ensureLoaded().providers[providerId] || {}).length;
}

export function listProviders(): string[] {
  return Object.keys(ensureLoaded().providers);
}

export function listModelsForProvider(providerId: string): string[] {
  return Object.keys(ensureLoaded().providers[providerId] ?? {});
}

export function listProvidersForModelId(modelId: string): string[] {
  const providers = ensureModelIndex().get(modelId) ?? [];
  return [...providers].sort((a, b) => a.localeCompare(b));
}

export function lookupCost(providerId: string, modelId: string): CostBuckets | null {
  const p = ensureLoaded().providers[providerId];
  if (!p) return null;
  const c = p[modelId];
  if (!c) return null;
  return c;
}

export function hasCost(providerId: string, modelId: string): boolean {
  return lookupCost(providerId, modelId) != null;
}
