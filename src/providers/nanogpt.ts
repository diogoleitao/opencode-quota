/**
 * NanoGPT provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { formatNanoGptBalanceValue, hasNanoGptApiKeyConfigured, queryNanoGptQuota } from "../lib/nanogpt.js";

function formatUsageAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(Math.trunc(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${formatUsageAmount(window.used)}/${formatUsageAmount(window.limit)}`;
}

export const nanoGptProvider: QuotaProvider = {
  id: "nanogpt",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const hasApiKey = await hasNanoGptApiKeyConfigured();
    try {
      const resp = await ctx.client.config.providers();
      const ids = new Set((resp.data?.providers ?? []).map((provider) => provider.id));
      if (ids.has("nanogpt") || ids.has("nano-gpt")) {
        return hasApiKey;
      }
    } catch {
      // Ignore provider lookup failures and fall back to key presence.
    }

    return hasApiKey;
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    return provider === "nanogpt" || provider === "nano-gpt";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryNanoGptQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "NanoGPT", message: result.error }],
      };
    }

    const style = ctx.config.toastStyle ?? "classic";
    const entries: QuotaToastEntry[] = [];
    const errors =
      result.endpointErrors?.map((entry) => ({
        label: entry.endpoint === "usage" ? "NanoGPT Usage" : "NanoGPT Balance",
        message: entry.message,
      })) ?? [];

    const subscription = result.subscription;
    if (subscription?.daily) {
      entries.push(
        style === "grouped"
          ? {
              name: "NanoGPT Daily",
              group: "NanoGPT",
              label: "Daily:",
              right: formatUsageRight(subscription.daily),
              percentRemaining: subscription.daily.percentRemaining,
              resetTimeIso: subscription.daily.resetTimeIso,
            }
          : {
              name: "NanoGPT Daily",
              percentRemaining: subscription.daily.percentRemaining,
              resetTimeIso: subscription.daily.resetTimeIso,
            },
      );
    }

    if (subscription?.monthly) {
      entries.push(
        style === "grouped"
          ? {
              name: "NanoGPT Monthly",
              group: "NanoGPT",
              label: "Monthly:",
              right: formatUsageRight(subscription.monthly),
              percentRemaining: subscription.monthly.percentRemaining,
              resetTimeIso: subscription.monthly.resetTimeIso,
            }
          : {
              name: "NanoGPT Monthly",
              percentRemaining: subscription.monthly.percentRemaining,
              resetTimeIso: subscription.monthly.resetTimeIso,
            },
      );
    }

    const balanceValue = result.balance ? formatNanoGptBalanceValue(result.balance) : null;
    if (balanceValue) {
      entries.push(
        style === "grouped"
          ? {
              kind: "value",
              name: "NanoGPT Balance",
              group: "NanoGPT",
              label: "Balance:",
              value: balanceValue,
            }
          : {
              kind: "value",
              name: "NanoGPT Balance",
              value: balanceValue,
            },
      );
    }

    if (subscription?.state && subscription.state.toLowerCase() !== "active") {
      errors.push({
        label: "NanoGPT",
        message: `Subscription state: ${subscription.state}`,
      });
    }

    if (entries.length === 0) {
      errors.push({
        label: "NanoGPT",
        message: "No usable NanoGPT quota or balance data",
      });
    }

    return {
      attempted: true,
      entries,
      errors,
    };
  },
};
