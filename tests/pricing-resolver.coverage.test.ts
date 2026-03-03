import { describe, expect, it } from "vitest";

import {
  listModelsForProvider,
  listProviders,
  lookupCost,
} from "../src/lib/modelsdev-pricing.js";
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
});
