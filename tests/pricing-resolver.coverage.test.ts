import { describe, expect, it } from "vitest";

import { listModelsForProvider, listProviders } from "../src/lib/modelsdev-pricing.js";
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
});

