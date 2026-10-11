# Pi compaction model

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
| `/compaction-model show` | Show the saved selection and settings path |
| `/compaction-model reset` | Restore Pi's default compaction behavior |

For example, if you have configured Google authentication:

```text
/compaction-model google gemini-2.5-flash
/compact
```

This example does not guarantee the lowest price. Check your provider's rates and choose a model with enough context capacity.

The picker lists models that Pi reports as available. Escape cancels without a settings change. RPC uses a select dialog. Without UI, the bare command shows the selection and usage.

Selection does not call a model. Later compaction sends session contents to the selected provider. Check that provider's billing and retention terms.

## Behavior

- The selection applies to manual and automatic compaction.
- The conversation model and thinking level stay unchanged.
- Pi keeps its summary format, recent messages, previous summary, split-turn handling, and usage accounting.
- File lists remain cumulative across this extension's compactions.
- Branch summaries still use Pi's default behavior.
- The extension does not add retries or inherit conversation reasoning settings.
- Failed or cancelled configured compaction stops. It does not fall back to the conversation model.
- With no selection, Pi uses its normal compaction.

The extension checks Pi's estimated summary-input tokens plus the requested output allowance against the selected model's context window. The estimate is not an exact tokenizer. A smaller model can therefore reject a compaction that your conversation model could handle.

Compaction can disrupt prompt caching. More frequent compaction does not always reduce your bill. This package does not change Pi's compaction thresholds.

Use one compaction override at a time. Other extensions can replace successful hook results.

## Settings

The selection persists across sessions in `<agentDir>/compaction-model.json`. Pi's `getAgentDir()` selects the directory, including profile-specific directories.

```json
{
  "model": {
    "provider": "google",
    "model": "gemini-2.5-flash"
  }
}
```

A missing file or `{}` enables Pi's default behavior. The package does not support project overrides.

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

Additional `AgentSession` checks confirm single summary persistence, retained context, reload metadata, and failure cancellation without fallback.
