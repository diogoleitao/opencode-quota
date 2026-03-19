import type { CursorQuotaPlan } from "./types.js";
import type { CostBuckets } from "./modelsdev-pricing.js";

export type CursorLocalPricingModel = "auto" | "composer" | "composer-fast";

export type CursorResolvedModel =
  | { kind: "local"; model: CursorLocalPricingModel; pool: "auto_composer" }
  | { kind: "official"; providerHint: string; modelHint: string; pool: "api" }
  | { kind: "unknown" };

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_OPENCODE_PROVIDER_ID = "cursor-acp";

export const CURSOR_INCLUDED_API_USD_BY_PLAN: Readonly<Record<Exclude<CursorQuotaPlan, "none">, number>> = {
  pro: 20,
  "pro-plus": 70,
  ultra: 400,
};

const CURSOR_PROVIDER_IDS = new Set([
  CURSOR_PROVIDER_ID,
  CURSOR_OPENCODE_PROVIDER_ID,
  "open-cursor",
  "@rama_nigg/open-cursor",
]);

const CURSOR_LOCAL_PRICING: Readonly<Record<CursorLocalPricingModel, CostBuckets>> = {
  auto: {
    input: 1.25,
    output: 6,
    cache_read: 0.25,
  },
  composer: {
    input: 0.5,
    output: 2.5,
    cache_read: 0.2,
  },
  "composer-fast": {
    input: 1.5,
    output: 7.5,
    cache_read: 0.35,
  },
};

export const CURSOR_OFFICIAL_MODEL_ALIASES: Readonly<
  Record<string, { providerHint: string; modelHint: string }>
> = {
  "gemini-3-flash": { providerHint: "google", modelHint: "gemini-3-flash-preview" },
  "gemini-3-pro": { providerHint: "google", modelHint: "gemini-3-pro-preview" },
  "gemini-3.1-pro": { providerHint: "google", modelHint: "gemini-3.1-pro-preview" },
  "gpt-5.2": { providerHint: "openai", modelHint: "gpt-5.2" },
  "gpt-5.3-codex": { providerHint: "openai", modelHint: "gpt-5.3-codex" },
  "gpt-5.4": { providerHint: "openai", modelHint: "gpt-5.4" },
  "gpt-5.4-high": { providerHint: "openai", modelHint: "gpt-5.4" },
  "gpt-5.4-medium": { providerHint: "openai", modelHint: "gpt-5.4" },
  grok: { providerHint: "xai", modelHint: "grok-code-fast-1" },
  "kimi-k2.5": { providerHint: "moonshotai", modelHint: "kimi-k2.5" },
  "opus-4.5": { providerHint: "anthropic", modelHint: "claude-opus-4-5" },
  "opus-4.5-thinking": { providerHint: "anthropic", modelHint: "claude-opus-4-5" },
  "opus-4.6": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "opus-4.6-thinking": { providerHint: "anthropic", modelHint: "claude-opus-4-6" },
  "premium-routing": { providerHint: "cursor", modelHint: "premium-routing" },
  "sonnet-4.5": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "sonnet-4.5-thinking": { providerHint: "anthropic", modelHint: "claude-sonnet-4-5" },
  "sonnet-4.6": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
  "sonnet-4.6-thinking": { providerHint: "anthropic", modelHint: "claude-sonnet-4-6" },
};

export function isCursorProviderId(raw?: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  return CURSOR_PROVIDER_IDS.has(raw.trim().toLowerCase());
}

export function isCursorModelId(raw?: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized.startsWith(`${CURSOR_OPENCODE_PROVIDER_ID}/`) || normalized.startsWith("cursor/");
}

export function extractCursorModelPart(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return trimmed.toLowerCase();
  return trimmed.slice(lastSlash + 1).trim().toLowerCase();
}

export function getCursorPlanDisplayName(plan: CursorQuotaPlan): string | null {
  switch (plan) {
    case "pro":
      return "Pro";
    case "pro-plus":
      return "Pro Plus";
    case "ultra":
      return "Ultra";
    default:
      return null;
  }
}

export function getEffectiveCursorIncludedApiUsd(params: {
  plan: CursorQuotaPlan;
  overrideUsd?: number;
}): number | undefined {
  if (typeof params.overrideUsd === "number" && Number.isFinite(params.overrideUsd) && params.overrideUsd > 0) {
    return params.overrideUsd;
  }
  if (params.plan === "none") return undefined;
  return CURSOR_INCLUDED_API_USD_BY_PLAN[params.plan];
}

export function lookupCursorLocalCost(model: string): CostBuckets | null {
  return CURSOR_LOCAL_PRICING[model as CursorLocalPricingModel] ?? null;
}

export function resolveCursorModel(rawModelId?: string): CursorResolvedModel {
  if (!rawModelId || typeof rawModelId !== "string") return { kind: "unknown" };

  const model = extractCursorModelPart(rawModelId);
  if (!model) return { kind: "unknown" };

  if (model === "auto") {
    return { kind: "local", model: "auto", pool: "auto_composer" };
  }

  if (model.startsWith("composer")) {
    return {
      kind: "local",
      model: model.includes("fast") ? "composer-fast" : "composer",
      pool: "auto_composer",
    };
  }

  const official = CURSOR_OFFICIAL_MODEL_ALIASES[model];
  if (!official || official.providerHint === "cursor") {
    return { kind: "unknown" };
  }

  return { kind: "official", ...official, pool: "api" };
}
