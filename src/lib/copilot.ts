/**
 * GitHub Copilot premium request usage fetcher.
 *
 * The plugin only uses documented GitHub billing APIs:
 * - /users/{username}/settings/billing/premium_request/usage
 * - /organizations/{org}/settings/billing/premium_request/usage
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type {
  AuthData,
  CopilotAuthData,
  CopilotQuotaConfig,
  CopilotQuotaResult,
  CopilotResult,
  CopilotTier,
  QuotaError,
} from "./types.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile } from "./opencode-auth.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const COPILOT_QUOTA_CONFIG_FILENAME = "copilot-quota-token.json";
const USER_AGENT = "opencode-quota/copilot-billing";

type GitHubRestAuthScheme = "bearer" | "token";
type CopilotAuthKeyName =
  | "github-copilot"
  | "copilot"
  | "copilot-chat"
  | "github-copilot-chat";
type CopilotPatTokenKind = "github_pat" | "ghp" | "other";
type EffectiveCopilotAuthSource = "pat" | "oauth" | "none";

export type CopilotPatState = "absent" | "invalid" | "valid";

export interface CopilotPatReadResult {
  state: CopilotPatState;
  checkedPaths: string[];
  selectedPath?: string;
  config?: CopilotQuotaConfig;
  error?: string;
  tokenKind?: CopilotPatTokenKind;
}

export interface CopilotQuotaAuthDiagnostics {
  pat: CopilotPatReadResult;
  oauth: {
    configured: boolean;
    keyName: CopilotAuthKeyName | null;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
  };
  effectiveSource: EffectiveCopilotAuthSource;
  override: "pat_overrides_oauth" | "none";
}

interface BillingUsageItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  unit_type?: string;
  grossQuantity?: number;
  gross_quantity?: number;
  netQuantity?: number;
  net_quantity?: number;
  limit?: number;
}

interface BillingUsageResponse {
  timePeriod?: { year: number; month?: number };
  time_period?: { year: number; month?: number };
  user?: string;
  organization?: string;
  usageItems?: BillingUsageItem[];
  usage_items?: BillingUsageItem[];
}

interface GitHubViewerResponse {
  login?: string;
}

const COPILOT_PLAN_LIMITS: Record<CopilotTier, number> = {
  free: 50,
  pro: 300,
  "pro+": 1500,
  business: 300,
  enterprise: 1000,
};

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function classifyPatTokenKind(token: string): CopilotPatTokenKind {
  if (token.startsWith("github_pat_")) return "github_pat";
  if (token.startsWith("ghp_")) return "ghp";
  return "other";
}

export function getCopilotPatConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return dedupeStrings(
    configDirs.map((configDir) => join(configDir, COPILOT_QUOTA_CONFIG_FILENAME)),
  );
}

function validateQuotaConfig(raw: unknown): { config: CopilotQuotaConfig | null; error?: string } {
  if (!raw || typeof raw !== "object") {
    return { config: null, error: "Config must be a JSON object" };
  }

  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  const tier = typeof obj.tier === "string" ? obj.tier.trim() : "";

  if (!token) {
    return { config: null, error: "Missing required string field: token" };
  }

  const validTiers: CopilotTier[] = ["free", "pro", "pro+", "business", "enterprise"];
  if (!validTiers.includes(tier as CopilotTier)) {
    return {
      config: null,
      error: "Invalid tier; expected one of: free, pro, pro+, business, enterprise",
    };
  }

  const usernameRaw = obj.username;
  let username: string | undefined;
  if (usernameRaw != null) {
    if (typeof usernameRaw !== "string" || !usernameRaw.trim()) {
      return { config: null, error: "username must be a non-empty string when provided" };
    }
    username = usernameRaw.trim();
  }

  const organizationRaw = obj.organization;
  let organization: string | undefined;
  if (organizationRaw != null) {
    if (typeof organizationRaw !== "string" || !organizationRaw.trim()) {
      return { config: null, error: "organization must be a non-empty string when provided" };
    }
    organization = organizationRaw.trim();
  }

  return {
    config: {
      token,
      tier: tier as CopilotTier,
      username,
      organization,
    },
  };
}

export function readQuotaConfigWithMeta(): CopilotPatReadResult {
  const checkedPaths = getCopilotPatConfigCandidatePaths();

  for (const path of checkedPaths) {
    if (!existsSync(path)) continue;

    try {
      const content = readFileSync(path, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      const validated = validateQuotaConfig(parsed);

      if (!validated.config) {
        return {
          state: "invalid",
          checkedPaths,
          selectedPath: path,
          error: validated.error ?? "Invalid config",
        };
      }

      return {
        state: "valid",
        checkedPaths,
        selectedPath: path,
        config: validated.config,
        tokenKind: classifyPatTokenKind(validated.config.token),
      };
    } catch (error) {
      return {
        state: "invalid",
        checkedPaths,
        selectedPath: path,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { state: "absent", checkedPaths };
}

function selectCopilotAuth(authData: AuthData | null): {
  auth: CopilotAuthData | null;
  keyName: CopilotAuthKeyName | null;
} {
  if (!authData) {
    return { auth: null, keyName: null };
  }

  const candidates: Array<[CopilotAuthKeyName, CopilotAuthData | undefined]> = [
    ["github-copilot", authData["github-copilot"]],
    ["copilot", authData.copilot],
    ["copilot-chat", authData["copilot-chat"]],
    ["github-copilot-chat", authData["github-copilot-chat"]],
  ];

  for (const [keyName, auth] of candidates) {
    if (!auth || auth.type !== "oauth") continue;
    if (!auth.access && !auth.refresh) continue;
    return { auth, keyName };
  }

  return { auth: null, keyName: null };
}

export function getCopilotQuotaAuthDiagnostics(authData: AuthData | null): CopilotQuotaAuthDiagnostics {
  const pat = readQuotaConfigWithMeta();
  const { auth, keyName } = selectCopilotAuth(authData);

  let effectiveSource: EffectiveCopilotAuthSource = "none";
  if (pat.state === "valid") effectiveSource = "pat";
  else if (auth) effectiveSource = "oauth";

  return {
    pat,
    oauth: {
      configured: Boolean(auth),
      keyName,
      hasRefreshToken: Boolean(auth?.refresh),
      hasAccessToken: Boolean(auth?.access),
    },
    effectiveSource,
    override: pat.state === "valid" && auth ? "pat_overrides_oauth" : "none",
  };
}

function buildGitHubRestHeaders(
  token: string,
  scheme: GitHubRestAuthScheme,
): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: scheme === "bearer" ? `Bearer ${token}` : `token ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

function preferredSchemesForToken(token: string): GitHubRestAuthScheme[] {
  if (token.startsWith("ghp_")) {
    return ["token", "bearer"];
  }

  return ["bearer", "token"];
}

async function readGitHubRestErrorMessage(response: Response): Promise<string> {
  const text = await response.text();

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : null;
    const documentationUrl =
      typeof parsed.documentation_url === "string" ? parsed.documentation_url : null;

    if (message && documentationUrl) {
      return `${message} (${documentationUrl})`;
    }

    if (message) {
      return message;
    }
  } catch {
    // ignore parse failures
  }

  return text.slice(0, 160);
}

async function fetchGitHubRestJsonOnce<T>(
  url: string,
  token: string,
  scheme: GitHubRestAuthScheme,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; message: string }> {
  const response = await fetchWithTimeout(url, {
    headers: buildGitHubRestHeaders(token, scheme),
  });

  if (response.ok) {
    return { ok: true, status: response.status, data: (await response.json()) as T };
  }

  return {
    ok: false,
    status: response.status,
    message: await readGitHubRestErrorMessage(response),
  };
}

async function resolveGitHubUsername(token: string): Promise<string> {
  const url = `${GITHUB_API_BASE_URL}/user`;
  let unauthorized: { status: number; message: string } | null = null;

  for (const scheme of preferredSchemesForToken(token)) {
    const result = await fetchGitHubRestJsonOnce<GitHubViewerResponse>(url, token, scheme);

    if (result.ok) {
      const login = result.data.login?.trim();
      if (login) return login;
      throw new Error("GitHub /user response did not include a login");
    }

    if (result.status === 401) {
      unauthorized = { status: result.status, message: result.message };
      continue;
    }

    throw new Error(`GitHub API error ${result.status}: ${result.message}`);
  }

  if (unauthorized) {
    throw new Error(
      `GitHub API error ${unauthorized.status}: ${unauthorized.message} (token rejected while resolving username)`,
    );
  }

  throw new Error("Unable to resolve GitHub username for Copilot billing request");
}

function getBillingRequestUrl(params: {
  organization?: string;
  username?: string;
}): string {
  if (params.organization) {
    const base = `${GITHUB_API_BASE_URL}/organizations/${encodeURIComponent(params.organization)}/settings/billing/premium_request/usage`;
    return params.username ? `${base}?user=${encodeURIComponent(params.username)}` : base;
  }

  if (!params.username) {
    throw new Error("GitHub username is required for user premium request usage");
  }

  return `${GITHUB_API_BASE_URL}/users/${encodeURIComponent(params.username)}/settings/billing/premium_request/usage`;
}

async function fetchPremiumRequestUsage(params: {
  token: string;
  username?: string;
  organization?: string;
}): Promise<BillingUsageResponse> {
  const username = params.organization ? params.username : params.username ?? (await resolveGitHubUsername(params.token));
  const url = getBillingRequestUrl({
    organization: params.organization,
    username,
  });

  let unauthorized: { status: number; message: string } | null = null;

  for (const scheme of preferredSchemesForToken(params.token)) {
    const result = await fetchGitHubRestJsonOnce<BillingUsageResponse>(url, params.token, scheme);

    if (result.ok) {
      return result.data;
    }

    if (result.status === 401) {
      unauthorized = { status: result.status, message: result.message };
      continue;
    }

    throw new Error(`GitHub API error ${result.status}: ${result.message}`);
  }

  if (unauthorized) {
    throw new Error(
      `GitHub API error ${unauthorized.status}: ${unauthorized.message} (token rejected for Copilot premium request usage)`,
    );
  }

  throw new Error("Unable to fetch Copilot premium request usage");
}

function getApproxNextResetIso(nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function computePercentRemainingFromUsed(params: { used: number; total: number }): number {
  const { used, total } = params;
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(used) || used <= 0) return 100;
  const usedPct = Math.max(0, Math.min(100, Math.ceil((used / total) * 100)));
  return 100 - usedPct;
}

function toQuotaResultFromBilling(
  response: BillingUsageResponse,
  fallbackTier?: CopilotTier,
): CopilotQuotaResult {
  const items = Array.isArray(response.usageItems)
    ? response.usageItems
    : Array.isArray(response.usage_items)
      ? response.usage_items
      : [];

  const premiumItems = items.filter((item) => {
    if (!item || typeof item !== "object") return false;
    if (typeof item.sku !== "string") return false;
    return item.sku === "Copilot Premium Request" || item.sku.includes("Premium");
  });

  if (premiumItems.length === 0 && items.length > 0) {
    const skus = items.map((item) => (typeof item?.sku === "string" ? item.sku : "?")).join(", ");
    throw new Error(
      `No premium-request items found in billing response (${items.length} items, SKUs: ${skus}). Expected an item with SKU containing "Premium".`,
    );
  }

  if (premiumItems.length === 0) {
    throw new Error("Billing API returned empty usageItems array for Copilot premium requests.");
  }

  const used = premiumItems.reduce((sum, item) => {
    const gross = item.grossQuantity ?? item.gross_quantity ?? 0;
    return sum + (typeof gross === "number" ? gross : 0);
  }, 0);

  const apiLimits = premiumItems
    .map((item) => item.limit)
    .filter((limit): limit is number => typeof limit === "number" && limit > 0);

  const total = apiLimits.length > 0 ? Math.max(...apiLimits) : fallbackTier ? COPILOT_PLAN_LIMITS[fallbackTier] : undefined;

  if (!total || total <= 0) {
    throw new Error(
      "Copilot billing response did not include a limit. Configure copilot-quota-token.json with your tier so the plugin can compute quota totals.",
    );
  }

  return {
    success: true,
    used,
    total,
    percentRemaining: computePercentRemainingFromUsed({ used, total }),
    resetTimeIso: getApproxNextResetIso(),
  };
}

function getOAuthTokenCandidates(auth: CopilotAuthData): string[] {
  return dedupeStrings([auth.access, auth.refresh]);
}

function toQuotaError(message: string): QuotaError {
  return { success: false, error: message };
}

function validatePatBillingScope(config: CopilotQuotaConfig): string | null {
  const isOrgTier = config.tier === "business" || config.tier === "enterprise";
  if (isOrgTier && !config.organization) {
    return (
      `Copilot ${config.tier} usage requires an organization-scoped billing report. ` +
      `Add "organization": "your-org-slug" to copilot-quota-token.json.`
    );
  }

  return null;
}

/**
 * Query GitHub Copilot premium request usage.
 *
 * PAT configuration wins over OpenCode OAuth auth when both are present.
 */
export async function queryCopilotQuota(): Promise<CopilotResult> {
  const pat = readQuotaConfigWithMeta();

  if (pat.state === "invalid") {
    return toQuotaError(
      `Invalid copilot-quota-token.json: ${pat.error ?? "unknown error"}${pat.selectedPath ? ` (${pat.selectedPath})` : ""}`,
    );
  }

  if (pat.state === "valid" && pat.config) {
    const scopeError = validatePatBillingScope(pat.config);
    if (scopeError) return toQuotaError(scopeError);

    try {
      const response = await fetchPremiumRequestUsage({
        token: pat.config.token,
        username: pat.config.username,
        organization: pat.config.organization,
      });
      return toQuotaResultFromBilling(response, pat.config.tier);
    } catch (error) {
      return toQuotaError(error instanceof Error ? error.message : String(error));
    }
  }

  const authData = await readAuthFile();
  const { auth } = selectCopilotAuth(authData);
  if (!auth) {
    return null;
  }

  const tokenCandidates = getOAuthTokenCandidates(auth);
  if (tokenCandidates.length === 0) {
    return null;
  }

  let lastError: string | null = null;

  for (const token of tokenCandidates) {
    try {
      const response = await fetchPremiumRequestUsage({ token });
      return toQuotaResultFromBilling(response);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return toQuotaError(
    lastError ??
      "Copilot billing usage could not be fetched from OpenCode auth. Configure copilot-quota-token.json to provide an explicit tier and PAT.",
  );
}

export function formatCopilotQuota(result: CopilotResult): string | null {
  if (!result || !result.success) {
    return null;
  }

  const percentUsed = 100 - result.percentRemaining;
  return `Copilot ${result.used}/${result.total} (${percentUsed}%)`;
}
