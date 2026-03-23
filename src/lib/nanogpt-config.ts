/**
 * NanoGPT API key configuration resolver.
 *
 * Resolution priority (first wins):
 * 1. Environment variable: NANOGPT_API_KEY or NANO_GPT_API_KEY
 * 2. User/global opencode.json/opencode.jsonc: provider.nanogpt.options.apiKey
 *    or provider["nano-gpt"].options.apiKey
 * 3. auth.json: nanogpt.key or nano-gpt.key
 */

import { resolveEnvTemplate } from "./env-template.js";
import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import {
  getApiKeyDiagnostics,
  getGlobalOpencodeConfigCandidatePaths,
  resolveApiKey,
} from "./api-key-resolver.js";

/** Result of NanoGPT API key resolution */
export interface NanoGptApiKeyResult {
  key: string;
  source: NanoGptKeySource;
}

const ALLOWED_NANOGPT_ENV_VARS = ["NANOGPT_API_KEY", "NANO_GPT_API_KEY"] as const;

/** Source of the resolved API key */
export type NanoGptKeySource =
  | "env:NANOGPT_API_KEY"
  | "env:NANO_GPT_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

function extractNanoGptKeyFromProviderConfig(
  providerKey: "nanogpt" | "nano-gpt",
  config: unknown,
): string | null {
  if (!config || typeof config !== "object") return null;

  const root = config as Record<string, unknown>;
  const provider = root.provider;
  if (!provider || typeof provider !== "object") return null;

  const entry = (provider as Record<string, unknown>)[providerKey];
  if (!entry || typeof entry !== "object") return null;

  const options = (entry as Record<string, unknown>).options;
  if (!options || typeof options !== "object") return null;

  const apiKey = (options as Record<string, unknown>).apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return null;

  return resolveEnvTemplate(apiKey.trim(), ALLOWED_NANOGPT_ENV_VARS);
}

function extractNanoGptKeyFromConfig(config: unknown): string | null {
  return (
    extractNanoGptKeyFromProviderConfig("nanogpt", config) ??
    extractNanoGptKeyFromProviderConfig("nano-gpt", config)
  );
}

function extractNanoGptKeyFromAuth(auth: unknown): string | null {
  if (!auth || typeof auth !== "object") return null;

  const root = auth as Record<string, unknown>;
  const nanoGpt = (root.nanogpt ?? root["nano-gpt"]) as
    | { type?: string; key?: string }
    | undefined;

  if (nanoGpt && nanoGpt.type === "api" && nanoGpt.key && nanoGpt.key.trim().length > 0) {
    return nanoGpt.key.trim();
  }

  return null;
}

// Re-export for consumers that need path info
export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

export async function resolveNanoGptApiKey(): Promise<NanoGptApiKeyResult | null> {
  return resolveApiKey<NanoGptKeySource>(
    {
      envVars: [
        { name: "NANOGPT_API_KEY", source: "env:NANOGPT_API_KEY" },
        { name: "NANO_GPT_API_KEY", source: "env:NANO_GPT_API_KEY" },
      ],
      extractFromConfig: extractNanoGptKeyFromConfig,
      configJsonSource: "opencode.json",
      configJsoncSource: "opencode.jsonc",
      extractFromAuth: extractNanoGptKeyFromAuth,
      authSource: "auth.json",
      getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    },
    readAuthFile,
  );
}

export async function hasNanoGptApiKey(): Promise<boolean> {
  const result = await resolveNanoGptApiKey();
  return result !== null;
}

export async function getNanoGptKeyDiagnostics(): Promise<{
  configured: boolean;
  source: NanoGptKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  const authPaths = getAuthPaths();
  const diagnostics = await getApiKeyDiagnostics<NanoGptKeySource>({
    envVarNames: ["NANOGPT_API_KEY", "NANO_GPT_API_KEY"],
    resolve: resolveNanoGptApiKey,
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });

  return {
    ...diagnostics,
    authPaths,
  };
}
