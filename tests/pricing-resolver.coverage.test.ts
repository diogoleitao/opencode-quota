import { describe, expect, it } from "vitest";

import {
  listModelsForProvider,
  listProviders,
  lookupCost,
} from "../src/lib/modelsdev-pricing.js";
import { CURSOR_OFFICIAL_MODEL_ALIASES } from "../src/lib/cursor-pricing.js";
import { resolvePricingKey } from "../src/lib/quota-stats.js";

describe("resolvePricingKey snapshot coverage", () => {
  it("resolves every models.dev provider/model pair when source ids are official", () => {
    const failures: string[] = [];
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);

    outer: for (const providerID of providers) {
      const modelIDs = listModelsForProvider(providerID);
      for (const modelID of modelIDs) {
        const resolved = resolvePricingKey({ providerID, modelID });
        if (!resolved.ok) {
          failures.push(`${providerID}/${modelID} -> unresolved`);
        } else if (resolved.key.provider !== providerID || resolved.key.model !== modelID) {
          failures.push(
            `${providerID}/${modelID} -> ${resolved.key.provider}/${resolved.key.model} (${resolved.method})`,
          );
        }
        if (failures.length >= 10) break outer;
      }
    }

    expect(failures).toEqual([]);
  });

  it("resolves provider/model prefixes even when source provider id is unknown", () => {
    const providers = listProviders();
    const providerID = providers[0];
    expect(providerID).toBeTruthy();

    const modelID = listModelsForProvider(providerID!)[0];
    expect(modelID).toBeTruthy();

    const resolved = resolvePricingKey({
      providerID: "connector-without-pricing-id",
      modelID: `${providerID}/${modelID}`,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.key.provider).toBe(providerID);
    expect(resolved.key.model).toBe(modelID);
  });

  it("maps copilot and proxy model variants to priced snapshot keys", () => {
    const copilotHaiku = resolvePricingKey({
      providerID: "github-copilot",
      modelID: "github-copilot/claude-haiku-4.5",
    });
    expect(copilotHaiku.ok).toBe(true);
    if (!copilotHaiku.ok) return;
    expect(copilotHaiku.key).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });

    const copilotGrok = resolvePricingKey({
      providerID: "github-copilot",
      modelID: "github-copilot/grok-code-fast-1",
    });
    expect(copilotGrok.ok).toBe(true);
    if (!copilotGrok.ok) return;
    expect(copilotGrok.key).toEqual({ provider: "xai", model: "grok-code-fast-1" });

    const kimiBase = resolvePricingKey({
      providerID: "CLIProxyAPI",
      modelID: "moonshotai/kimi-k2.5",
    });
    expect(kimiBase.ok).toBe(true);
    if (!kimiBase.ok) return;
    expect(kimiBase.key).toEqual({ provider: "moonshotai", model: "kimi-k2.5" });

    const kimiFree = resolvePricingKey({
      providerID: "opencode",
      modelID: "opencode/kimi-k2.5-free",
    });
    expect(kimiFree.ok).toBe(true);
    if (!kimiFree.ok) return;
    expect(kimiFree.key).toEqual({ provider: "moonshotai", model: "kimi-k2.5" });

    const openaiFreeKnownProvider = resolvePricingKey({
      providerID: "openai",
      modelID: "openai/gpt-4o-mini-free",
    });
    expect(openaiFreeKnownProvider.ok).toBe(true);
    if (!openaiFreeKnownProvider.ok) return;
    expect(openaiFreeKnownProvider.key).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    const openaiFreeModelPrefix = resolvePricingKey({
      providerID: "connector-without-pricing-id",
      modelID: "openai/gpt-4o-mini-free",
    });
    expect(openaiFreeModelPrefix.ok).toBe(true);
    if (!openaiFreeModelPrefix.ok) return;
    expect(openaiFreeModelPrefix.key).toEqual({ provider: "openai", model: "gpt-4o-mini" });

    expect(lookupCost("anthropic", "claude-haiku-4-5")).not.toBeNull();
    expect(lookupCost("xai", "grok-code-fast-1")).not.toBeNull();
    expect(lookupCost("moonshotai", "kimi-k2.5")).not.toBeNull();
    expect(lookupCost("openai", "gpt-4o-mini")).not.toBeNull();
  });

  it("maps cursor local and api-pool models into deterministic pricing keys", () => {
    const auto = resolvePricingKey({
      providerID: "cursor-acp",
      modelID: "cursor-acp/auto",
    });
    expect(auto.ok).toBe(true);
    if (!auto.ok) return;
    expect(auto.key).toEqual({ provider: "cursor", model: "auto" });

    const composer = resolvePricingKey({
      providerID: "cursor-acp",
      modelID: "cursor-acp/composer-1.5",
    });
    expect(composer.ok).toBe(true);
    if (!composer.ok) return;
    expect(composer.key).toEqual({ provider: "cursor", model: "composer" });

    const gpt = resolvePricingKey({
      providerID: "cursor-acp",
      modelID: "cursor-acp/gpt-5.4-high",
    });
    expect(gpt.ok).toBe(true);
    if (!gpt.ok) return;
    expect(gpt.key).toEqual({ provider: "openai", model: "gpt-5.4" });

    const anthropic = resolvePricingKey({
      providerID: "cursor-acp",
      modelID: "cursor-acp/sonnet-4.6-thinking",
    });
    expect(anthropic.ok).toBe(true);
    if (!anthropic.ok) return;
    expect(anthropic.key).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("keeps every Cursor API alias aligned with a priced snapshot key", () => {
    const failures: string[] = [];

    for (const alias of Object.keys(CURSOR_OFFICIAL_MODEL_ALIASES).sort()) {
      const target = CURSOR_OFFICIAL_MODEL_ALIASES[alias];
      if (!target || target.providerHint === "cursor") continue;

      const resolved = resolvePricingKey({
        providerID: "cursor-acp",
        modelID: `cursor-acp/${alias}`,
      });

      if (!resolved.ok) {
        failures.push(`${alias} -> unresolved`);
        continue;
      }

      if (resolved.method !== "cursor_api_alias") {
        failures.push(`${alias} -> unexpected method ${resolved.method}`);
        continue;
      }

      if (
        resolved.key.provider !== target.providerHint ||
        resolved.key.model !== target.modelHint
      ) {
        failures.push(
          `${alias} -> ${resolved.key.provider}/${resolved.key.model} (expected ${target.providerHint}/${target.modelHint})`,
        );
        continue;
      }

      if (!lookupCost(resolved.key.provider, resolved.key.model)) {
        failures.push(`${alias} -> missing priced snapshot key ${resolved.key.provider}/${resolved.key.model}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
