# Pi compaction model

## Shared behavior

This package pins `@neruok/pi-common@0.1.0` for model selection, reasoning support, settings transactions, and safe command reporting.
Advisor and magic8ball also share completion mechanics. Domain workflows and result schemas remain extension-owned.
`npm ci --ignore-scripts` installs the library from npm. No sibling checkout is required.
Safe settings reports reach non-UI sessions without starting a model turn. Transcript viewing remains UI-only.
Shared settings writes refuse foreign locks and immediate-parent symlinks. Explicit compaction reset still repairs malformed regular files.
The library does not reclaim stale locks or guarantee power-loss durability. Inspect a failed save before retry.


Select a separate model for Pi compaction. Use a cheaper summarizer without changing your conversation model.

The `/compaction-model` picker follows `pi-advisor`. The extension uses Pi's public `compact()` helper, not a separate summary prompt.

## Install from npm

Requires Node 24 or later and Pi 1.1.0 or later within version 1.x.

```sh
pi install npm:@neruok/pi-compaction-model
```

Restart Pi or run `/reload` after installation. Use `/compaction-model` to select the summarizer. No model is selected by default.

## Load a local checkout

From the maintainer workspace, load the package for one Pi invocation:

```sh
pi -e ./projects/pi-compaction-model/worktrees/main
```

For a permanent local installation, run:

```sh
pi install ./projects/pi-compaction-model/worktrees/main
```

Installation changes Pi settings. This repository does not install itself or select a model.

## Commands

| Command | Action |
| --- | --- |
| `/compaction-model` | Open the searchable model picker |
| `/compaction-model <provider> <model>` | Save an available physical chat model |
| `/compaction-model reasoning` | Select supported reasoning effort with UI, or list choices without UI |
| `/compaction-model reasoning <level>` | Save reasoning effort for the selected compaction model |
| `/compaction-model show` | Show the saved model, reasoning effort, and settings path |
| `/compaction-model reset` | Restore Pi's default compaction behavior |

For example, if you have configured Google authentication:

```text
/compaction-model google gemini-2.5-flash
/compact
```

This example does not guarantee the lowest price. Check your provider's rates and choose a model with enough context capacity.

The picker lists models that Pi reports as available. Escape cancels without a settings change. RPC uses a select dialog. Without UI, the bare command shows the selection and usage.

Use `/compaction-model reasoning` after model selection to choose the summarizer's reasoning effort. For example:

```text
/compaction-model reasoning low
/compaction-model reasoning default
```

Choices are `default` plus the levels Pi advertises for the selected model. Possible levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Not every model supports every level. Non-reasoning models offer only `default` and `off`.

Omission and `default` keep the previous provider behavior. `off` uses Pi's native helper behavior, which omits the reasoning option. Neither setting guarantees that an always-reasoning provider disables internal reasoning. Selecting a model again resets effort to `default`. Escape leaves settings unchanged.

Selection does not call a model. Later compaction sends session contents to the selected provider. Check that provider's billing and retention terms. Higher reasoning effort can increase cost and latency.

## Behavior

- The selection applies to manual and automatic compaction.
- The conversation model and thinking level stay unchanged.
- Pi keeps its summary format, recent messages, previous summary, split-turn handling, and usage accounting.
- File lists remain cumulative across this extension's compactions.
- Branch summaries still use Pi's default behavior.
- The extension uses the saved compaction reasoning effort, not the conversation thinking level.
- Both split-turn requests keep the model and effort loaded at compaction start.
- The extension does not add retries or change Pi's summary-output allowance.
- Failed or cancelled configured compaction stops. It does not fall back to the conversation model.
- With no selection, Pi uses its normal compaction.

The extension checks Pi's estimated summary-input tokens plus the requested output allowance against the selected model's context window. The estimate is not an exact tokenizer. A smaller model can therefore reject a compaction that your conversation model could handle.

Compaction can disrupt prompt caching. More frequent compaction does not always reduce your bill. This package does not change Pi's compaction thresholds.

Use one compaction override at a time. Other extensions can replace successful hook results.

## Failure diagnostics

A failed compaction reports a safe category and the latest summary request's token budget. For example:

```text
Compaction stopped. Category: output-limit.
Estimated input: 250000 tokens. Output allowance: 13107 tokens. Context window: 1000000 tokens.
No default-model fallback.
```

| Category | Meaning |
| --- | --- |
| `settings` | The extension could not read valid settings, or the saved reasoning effort is unsupported. |
| `model-unavailable` | Model lookup failed, or the selected model is missing or virtual. |
| `authentication-unavailable` | Pi's configured-auth check failed. |
| `context-window` | The local input estimate plus output allowance exceeds the window, or the window is not positive. |
| `provider-error` | Provider dispatch threw an exception or returned an error response. |
| `output-limit` | The response reached its output limit. The summary is incomplete. |
| `aborted` | The signal or provider response indicates an abort. |
| `unexpected-stop` | The response has another non-success stop reason. |
| `tool-call` | A normal-stop response contains a tool call. |
| `empty-summary` | A normal-stop response contains no nonempty text. |
| `summary-error` | Another native-summary operation failed. |

The token counts describe the summary request, not the session footer. Split-turn failures report the latest request, not the earlier history request.

Counts show `unknown` before request preparation or when a numeric value is invalid. Input counts are estimates, not provider tokenizer counts.

Reports do not include raw exceptions, provider error messages, model identifiers, prompts, or summary contents. The `provider-error` category does not distinguish remote authentication, quota, network, or provider-side context failures.

Pi can then show `Compaction cancelled` because the extension stopped the operation. That message does not prove that you cancelled it.

## Settings

The selection persists across sessions in `<agentDir>/compaction-model.json`. Pi's `getAgentDir()` selects the directory, including profile-specific directories.

```json
{
  "model": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "reasoning": "low"
  }
}
```

The `reasoning` field is optional. Existing model-only settings retain their previous behavior. Unsupported saved effort stops compaction before provider dispatch. Use `/compaction-model reasoning default` to repair it when the model remains available.

A missing file or `{}` enables Pi's default behavior. `/compaction-model reset` clears the model and reasoning effort. The package does not support project overrides.

Malformed settings stop configured compaction. Use `/compaction-model reset` to repair a malformed regular file. Reads and writes reject symlinks and non-regular files. The settings limit is 16384 bytes, inclusive.

Writes use atomic replacement and Pi's in-process file mutation queue. Separate Pi processes are not locked together. Do not edit the same settings file concurrently from another process.

## Development

Tested with Node 24.21.0, TypeScript 5.9.3, and Pi 1.1.0. Host-provided Pi packages are peer dependencies. Development versions are pinned in `package.json`.

The Pi peer range is `^1.1.0`, which excludes versions below 1.1.0 and versions at or above 2.0.0. Only Pi 1.1.0 has been tested.

The `prepublishOnly` hook runs `npm run verify`. A verification failure stops npm publication. Publication still requires separate authorization and npm scope access.

```sh
npm install --ignore-scripts
npm run verify
```

Validation for this change reused the installed dependencies. It did not install packages or read real credentials.

Tests use temporary settings, mocked providers, the real picker component, Pi's resource loader, and Pi's `AgentSession`. They do not establish live-provider compatibility, summary quality, or billing savings.

The [generated contract](docs/pi-compaction-model.md) comes from the maintainer workspace documentation store. Do not edit that generated file.

### Acceptance trace

| Criteria | Checks | Baseline | Implemented |
| --- | --- | --- | --- |
| AC-1 | Command, RPC picker, inline picker | Failed: command absent | Pass |
| AC-2 | Native summary, file lists, context boundary | Failed: hook absent | Pass |
| AC-3 | Faults, cancellation, reporting failure | Failed: hook absent or reporting escaped | Pass |
| AC-4 | Settings read, save, reset, symlink refusal | Failed: settings behavior absent | Pass |
| AC-5 | No-selection default behavior | Pass | Pass |
| AC-6 | Installed-Pi package loading | Failed: command absent | Pass |
| AC-7 | Public metadata, peers, npm installation docs | Failed: package private | Pass |
| AC-8 | Prepublish verification success and failure | Failed: hook absent | Pass |
| AC-9 | Safe categories, request budgets, privacy and abort precedence | Failed: generic report | Pass |
| AC-10 | Reasoning commands, settings, supported choices, native requests and split-turn pinning | 24 changed checks failed. Invalid-value preservation passed. Existing 47 checks passed. | Pass: all 25 reasoning checks and existing 47 checks |

Additional `AgentSession` checks confirm single summary persistence, retained context, reload metadata, and failure cancellation without fallback.
