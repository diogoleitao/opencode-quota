# Opencode Quota

Track OpenCode quota & tokens via Toasts/Commands with zero context window pollution.

**Quota provider supports**: GitHub Copilot, OpenAI (Plus/Pro), Qwen Code, Chutes AI, Firmware AI, Google Antigravity, and Z.ai coding plan.

**Token provider supports**: All models and providers in [models.dev](https://models.dev).

## What It Does

**Quota Toasts** - See your remaining quota at a glance after each assistant response.

![Image of quota toasts](https://github.com/slkiser/opencode-quota/blob/main/toast.png)

**Token Report Commands** - Track token usage and estimated costs across sessions using local OpenCode SQLite history plus a local models.dev pricing snapshot. The plugin can refresh that local snapshot at runtime when stale.

![Image of /quota and /tokens_daily outputs](https://github.com/slkiser/opencode-quota/blob/main/quota.png)

## Requirements

- OpenCode >= 1.2.0 (uses SQLite `opencode.db` for session/message history)

This plugin no longer supports the legacy folder-based JSON session storage used by older OpenCode versions.

## Installation

Add to your `opencode.json` (strict JSON) or `opencode.jsonc` (JSONC with comments/trailing commas):

```json
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

That's it. Providers are auto-detected based on your OpenCode configuration. Toasts appear automatically after assistant responses.

**Optional:** To restrict which providers are queried, set `enabledProviders` explicitly:

```json
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "qwen-code", "google-antigravity"]
    }
  }
}
```

> **LLM Agents:** Ask your agent to install `https://github.com/slkiser/opencode-quota` with the providers you have enabled. See [LLM Agent Installation Instructions](#llm-agent-installation-instructions) for details.

## Commands

| Command           | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `/quota`          | Show quota toast (verbose)                                      |
| `/quota_status`   | Show diagnostics (config, providers, accounts) + pricing health |
|                   |                                                                 |
| `/tokens_today`   | Tokens used today (calendar day)                                |
| `/tokens_daily`   | Tokens used in last 24 hours                                    |
| `/tokens_weekly`  | Tokens used in last 7 days                                      |
| `/tokens_monthly` | Tokens used in last 30 days (incl. pricing sections)            |
| `/tokens_all`     | Tokens used all time                                            |
| `/tokens_session` | Tokens used in current session                                  |
| `/tokens_between` | Tokens between two dates (YYYY-MM-DD)                           |

Token reporting commands are the `/tokens_*` family (there is no `/token` command).

## Supported Quota Providers

| Provider           | Config ID            | Auth Source                                   |
| ------------------ | -------------------- | --------------------------------------------- |
| GitHub Copilot     | `copilot`            | OpenCode auth (automatic)                     |
| OpenAI (Plus/Pro)  | `openai`             | OpenCode auth (automatic)                     |
| Qwen Code (OAuth)  | `qwen-code`          | OpenCode auth via `opencode-qwencode-auth`    |
| Firmware AI        | `firmware`           | OpenCode auth or API key                      |
| Chutes AI          | `chutes`             | OpenCode auth or API key                      |
| Google Antigravity | `google-antigravity` | Multi-account via `opencode-antigravity-auth` |
| Z.ai               | `zai`                | OpenCode auth (automatic)                     |

Token pricing coverage is broader than quota provider support: `/tokens_*` maps usage against provider/model entries in the active local models.dev pricing snapshot.

Pricing refresh ownership is now runtime-based:

- A bundled snapshot (`src/data/modelsdev-pricing.min.json`) is always shipped as bootstrap/offline fallback.
- At plugin runtime, when `experimental.quotaToast.enabled` is `true`, pricing refresh runs as a bounded best-effort check (once per process window, plus persisted attempt tracking) during init and before `/tokens_*` / `/quota_status` report paths.
- If the active snapshot is older than 3 days, the plugin attempts to fetch `https://models.dev/api.json`, keeps only `input`, `output`, `cache_read`, `cache_write`, and writes a refreshed local runtime snapshot.
- If fetch fails, reports continue using the last local snapshot (no hard failure).

Runtime snapshot files are stored under the OpenCode cache directory:

- `.../opencode/opencode-quota/modelsdev-pricing.runtime.min.json`
- `.../opencode/opencode-quota/modelsdev-pricing.refresh-state.json`

Runtime refresh toggles:

```sh
# Disable runtime pricing refresh
OPENCODE_QUOTA_PRICING_AUTO_REFRESH=0

# Change stale threshold (default: 3 days)
OPENCODE_QUOTA_PRICING_MAX_AGE_DAYS=5
```

Maintainer-only bundled snapshot refresh (manual):

```sh
npm run pricing:refresh
npm run pricing:refresh:if-stale
npm run build
```

`pricing:refresh:if-stale` uses the same env knobs as runtime refresh (`OPENCODE_QUOTA_PRICING_AUTO_REFRESH`, `OPENCODE_QUOTA_PRICING_MAX_AGE_DAYS`).

### Provider-Specific Setup

<details>
<summary><strong>GitHub Copilot</strong></summary>

**Setup:** Works automatically if OpenCode has Copilot configured and logged in.

**Optional:** For more reliable quota reporting, provide a fine-grained PAT:

1. Create a fine-grained PAT at GitHub with **Account permissions > Plan > Read**
2. Create `copilot-quota-token.json` under OpenCode's runtime config directory (see `opencode debug paths`):

```json
{
  "token": "github_pat_...",
  "tier": "pro"
}
```

`username` is optional (kept for backwards compatibility). If provided, it is used only as a fallback for legacy GitHub REST paths.

Both fine-grained PATs (`github_pat_...`) and classic PATs (`ghp_...`) should work. Fine-grained PATs must include **Account permissions > Plan > Read**.

Tier options: `free`, `pro`, `pro+`, `business`, `enterprise`

</details>

<details>
<summary><strong>OpenAI</strong></summary>

**Setup:** Works automatically if OpenCode has OpenAI/ChatGPT configured.

</details>

<details>
<summary><strong>Qwen Code</strong></summary>

**Setup:** Requires OAuth credentials from the `opencode-qwencode-auth` plugin.

Quota output for Qwen is **local-only estimation**:

- 1000 requests per UTC day (resets at UTC midnight)
- 60 requests per rolling minute
- Counter increments on successful question-tool completions while plugin is enabled and current model is `qwen-code/*`

No remote quota endpoint is called for Qwen and Alibaba API is not used.

Local state file path:

- `.../opencode/opencode-quota/qwen-local-quota.json` (under OpenCode state dir)

Use `/quota_status` to verify auth detection and local Qwen counter status.
If the local Qwen state file is missing, `/quota_status` reports usage from a default empty state.

</details>

<details>
<summary><strong>Firmware AI</strong></summary>

**Setup:** Works automatically if OpenCode has Firmware configured. Alternatively, provide an API key:

```json
{
  "provider": {
    "firmware": {
      "options": {
        "apiKey": "{env:FIRMWARE_API_KEY}"
      }
    }
  },
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["firmware"]
    }
  }
}
```

The `apiKey` field supports `{env:VAR_NAME}` syntax or a direct key.

</details>

<details>
<summary><strong>Chutes AI</strong></summary>

**Setup:** Works automatically if OpenCode has Chutes configured. Alternatively, provide an API key:

```json
{
  "provider": {
    "chutes": {
      "options": {
        "apiKey": "{env:CHUTES_API_KEY}"
      }
    }
  },
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["chutes"]
    }
  }
}
```

</details>

<details>
<summary><strong>Google Antigravity</strong></summary>

**Setup:** Requires the `opencode-antigravity-auth` plugin for multi-account support:

```json
{
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"]
}
```

Account credentials are stored under OpenCode's runtime config directory (see `opencode debug paths`).

If you are troubleshooting, `/quota_status` prints the candidate paths checked for `antigravity-accounts.json`.

</details>

<details>
<summary><strong>Z.ai</strong></summary>

**Setup:** Works automatically if OpenCode has Z.ai (Coding Plan) configured.

</details>

## Configuration Reference

All options go under `experimental.quotaToast` in `opencode.json` or `opencode.jsonc`:

| Option              | Default      | Description                                                                                          |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `enabled`           | `true`       | Enable/disable plugin. When `false`, `/quota`, `/quota_status`, and `/tokens_*` are strict no-ops. |
| `enableToast`       | `true`       | Show popup toasts                                                                                    |
| `toastStyle`        | `classic`    | Toast layout style: `classic` or `grouped`                                                           |
| `enabledProviders`  | `"auto"`     | Provider IDs to query, or `"auto"` to detect                                                         |
| `minIntervalMs`     | `300000`     | Minimum ms between provider fetches (default: 5 min); Qwen local RPM stays live on question triggers |
| `toastDurationMs`   | `9000`       | How long toasts display (ms)                                                                         |
| `showOnIdle`        | `true`       | Show toast on idle trigger                                                                           |
| `showOnQuestion`    | `true`       | Show toast after a question/assistant response                                                       |
| `showOnCompact`     | `true`       | Show toast after session compaction                                                                  |
| `showOnBothFail`    | `true`       | If providers attempt and fail, show a fallback toast                                                 |
| `onlyCurrentModel`  | `false`      | Only show quota for the current model (best-effort)                                                  |
| `showSessionTokens` | `true`       | Show per-model input/output tokens in toast                                                          |
| `layout.maxWidth`   | `50`         | Formatting target width                                                                              |
| `layout.narrowAt`   | `42`         | Compact layout breakpoint                                                                            |
| `layout.tinyAt`     | `32`         | Ultra-compact layout breakpoint                                                                      |
| `googleModels`      | `["CLAUDE"]` | Google models: `CLAUDE`, `G3PRO`, `G3FLASH`, `G3IMAGE`                                               |
| `debug`             | `false`      | Show debug info in toasts (and a debug-only toast when otherwise suppressed)                         |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full policy and workflow.

This project prefers an issue-first contribution model for features, bug fixes, refactors, and behavioral changes. Local pre-commit checks run formatting, typecheck, and tests; PR CI currently runs typecheck and build across Node versions.

Issue/PR templates are enforced in `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md` for consistent titles and required validation details.

## Development

```sh
npm install
npm run typecheck
npm test
npm run test:watch
npm run build
```

## Troubleshooting

Toast not appearing? Run `/quota_status` to check config, provider availability, and whether `opencode.db` is detected.

If `opencode.db` is missing, run OpenCode once (OpenCode performs a one-time migration into SQLite on first run after upgrade).

---

<details id="llm-agent-installation-instructions">
<summary><strong>LLM Agent Installation Instructions</strong></summary>

### For LLM Agents: How to Install and Configure

This section provides instructions for LLM agents to install and configure `opencode-quota` based on the user's current OpenCode setup.

#### Step 1: Check Current Configuration

First, determine what providers the user has connected. You can:

1. Read the user's `opencode.json` or `opencode.jsonc` (typically at `~/.config/opencode/`)
2. Run `/connected` in OpenCode to see active providers
3. Ask the user which providers they use

#### Step 2: Install the Plugin

Add the plugin to the user's `opencode.json` (or `opencode.jsonc`):

```json
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

If the user already has plugins, append to the existing array.

#### Step 3: Configure Providers (Optional)

By default, providers are auto-detected. If the user wants to restrict which providers are queried, add explicit `enabledProviders`:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": [
        // Add only the providers the user has configured:
        // "copilot"            - if using GitHub Copilot
        // "openai"             - if using OpenAI/ChatGPT
        // "qwen-code"          - if using Qwen Code OAuth (requires opencode-qwencode-auth)
        // "firmware"           - if using Firmware AI
        // "chutes"             - if using Chutes AI
        // "google-antigravity" - if using Google Antigravity (requires opencode-antigravity-auth)
      ],
    },
  },
}
```

#### Provider Detection Guide

| If user's config has...                     | Add to enabledProviders |
| ------------------------------------------- | ----------------------- |
| `github-copilot` provider or Copilot models | `"copilot"`             |
| `openai` / `chatgpt` provider               | `"openai"`              |
| `qwen-code` provider                        | `"qwen-code"`           |
| `firmware` / `firmware-ai` provider         | `"firmware"`            |
| `chutes` provider                           | `"chutes"`              |
| `google` provider with antigravity models   | `"google-antigravity"`  |
| `opencode-antigravity-auth` in plugins      | `"google-antigravity"`  |
| `opencode-qwencode-auth` in plugins         | `"qwen-code"`           |

#### Example: Full Configuration

For a user with Copilot and Google Antigravity:

```jsonc
{
  "plugin": [
    "opencode-antigravity-auth", // Required for google-antigravity
    "@slkiser/opencode-quota",
  ],
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "google-antigravity"],
      "googleModels": ["CLAUDE"], // Options: CLAUDE, G3PRO, G3FLASH
      "minIntervalMs": 300000, // 5 minutes between fetches
      "toastDurationMs": 9000, // Toast shows for 9 seconds
    },
  },
}
```

#### Step 4: Verify Installation

After configuration, instruct the user to:

1. Restart OpenCode (or reload the window)
2. Run `/quota_status` to verify providers are detected
3. Run `/quota` to manually trigger a toast

#### Common Issues

- **Toast not showing**: Run `/quota_status` to diagnose
- **Google Antigravity not working**: Ensure `opencode-antigravity-auth` plugin is installed and accounts are configured
- **Copilot quota unreliable**: Consider setting up a fine-grained PAT (see Provider-Specific Setup above)

</details>

## License

MIT

## Remarks
Opencode Quota is not built by the OpenCode team and is not affiliated with them in any way. It is not affiliated with any providers listed above.
