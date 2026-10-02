# auto-handoff

**Continue a Codex task in a fresh session, with its key decisions, constraints, and next step intact.**

[中文](README.md) · English

When a long-running task needs a fresh session, retelling the background can leave out an important constraint, a failed approach, or unfinished work. auto-handoff combines a Codex skill with a CLI: prepare a structured handoff packet, initialize a new session with your chosen profile, and return an exact resume command.

```text
Current task → checkpoint → read-only initialization → resume the exact new session
```

Your old session and uncommitted changes stay in place. You choose when to hand off, which profile to use, and when to resume development.

> **Status: early version, focused on Codex CLI.** v0.1 verification snapshot, 2026-10-02: 67 core tests and 9 website tests passed (76 total) on Linux with Node.js 22.18.0 and 24.19.0. The command-help interfaces of Codex CLI 0.159.2 were checked. Authenticated session creation, model initialization, and interactive resume have not been verified end to end. macOS, native Windows, and WSL are also unverified. See [compatibility](docs/compatibility.md) and the [verification record](docs/verification.md) (Chinese).

## Let your Codex install it

**Copy this message into Codex to have it install the CLI and skill following the README:**

```text
Install the CLI and user-level skill from https://github.com/AaronYang0628/auto-handoff. Follow the README to check my Node.js version, complete installation, and run csm doctor. Do not change my profile or model configuration, and do not run a real handoff yet.
```

**No service needs to be started.** auto-handoff is an on-demand local CLI and Codex skill. It needs no Docker, listening ports, or background daemon. Installation does not start monitoring or perform a handoff. A real handoff is a separate action you request, using your chosen Codex model service.

Optional `csm watch` starts only when you explicitly run it: `--once` checks once and exits; without that flag it polls in the current terminal until Ctrl+C. Ordinary checkpoint / handoff does not depend on watch.

## Install once

You need:

- Node.js **22.18+** and npm
- Git
- Codex CLI; a real handoff additionally needs a profile you explicitly choose and have confirmed works

Run in your terminal:

```bash
git clone https://github.com/AaronYang0628/auto-handoff.git
cd auto-handoff
npm ci
npm link
csm install --scope user
csm doctor
```

`csm` is the project's CLI; `auto-handoff` is an alias for the same command. Installation currently uses a source checkout.

- `npm ci` builds the JavaScript runtime automatically; run `npm run build` if you disabled install scripts
- `npm link` points the CLI at this checkout, so keep the directory and its path in place
- `csm install --scope user` installs the skill into `~/.agents/skills` without changing your model, profile, or Codex configuration
- `csm doctor` checks required command-help interfaces; `supported` does not verify authentication, profile availability, or a real model call

Restart Codex, then check `/skills` for `auto-handoff`. The environment running the skill must also find `csm` on PATH. If npm's global directory is not writable, use a writable prefix appropriate for your Node installation rather than forcing an administrator-level install.

For a single project, use `csm install --scope project --cwd "/path/to/project"`. The installer stops if it finds an unmanaged skill or modified managed files instead of overwriting them.

## Already installed? Update the CLI and skill

Use the original checkout. First inspect `git status --short` and preserve or resolve any local changes, then run:

```bash
git pull --ff-only
npm ci
npm link
csm uninstall --scope user
csm install --scope user
csm doctor
```

When the bundled skill changes, the installer refuses to overwrite the older bundle, so remove the managed skill before reinstalling. **If uninstall returns a nonempty `preserved` list, stop, inspect and back up your edits, and merge them manually before continuing. Do not delete them to bypass the protection.** For project installs, use `--scope project --cwd "/path/to/project"`; include `--legacy-alias` on both commands if you installed that alias.

Keep the checkout at its existing path. Restart Codex and check `/skills`. Updating does not delete runtime state, change your profile, start monitoring, or perform a real handoff.

## Try drift checks in a real project

In the Codex conversation where you are developing your project, enter:

```text
$auto-handoff Start a drift-check trial for this project. Build a stable, sourced baseline from my confirmed goal, constraints, and acceptance criteria; ask me about missing information. Then record only evidence-backed incremental actions and verification results, and review relevant details when an anomaly appears. Do not silently rewrite the baseline or create a new session automatically.
```

**A drift-check trial does not require a fresh session or constant rereading of an entire CONTEXT.md.**

- Keep user-confirmed requirements and their sources in the baseline; revise it explicitly when the requirements change, rather than silently replacing it with the current agent's summary
- Cheap rules check evidenced no-progress repetition, deterministically checkable constraints, and missing or stale verification; unavailable fields remain `unknown`
- Only a candidate anomaly calls for a small review packet: the relevant constraint, recent evidence, and related files
- Context occupancy is capacity background or a checkpoint opportunity. It no longer produces `handoff_suggested` on its own or establishes declining model quality
- The CLI makes no additional judging-model calls and emits no self-score. Review in your existing Codex conversation still uses that model and its normal usage

See the [project trial guide](docs/drift-trial.md) (Chinese) for explicit source binding, supported evidence fields, targeted review, and feedback. Start with a small real task with clear acceptance criteria, and record useful alerts, false positives, uncertain cases, and missed anomalies. Synthetic tests do not establish real-project detection accuracy.

For a synthetic demonstration that reads no real project and calls no model, run this from the checkout:

```bash
node docs/drift-demo.mjs
```

It deliberately repeats the same failing check three times, produces a `no-gain-loop` candidate, and records false-positive feedback because these retries were intentional. After the intended fixture change, measured verification passes and the candidate clears. Temporary files are retained for inspection; this is not a real-project accuracy result.

## Use it in Codex

In the **Codex conversation you want to hand off**, enter this with your exact profile name:

```text
$auto-handoff Hand off the current task using profile=YOUR_PROFILE
```

You can also select `auto-handoff` through `/skills` and name the target profile. You supply the profile for each handoff. No personal model, provider, or account configuration is bundled.

The skill will:

1. Confirm the current session ID, working directory, and target profile; ask for missing details rather than guess the latest session
2. After known writers stop, collect the goal, constraints, decisions, rejected approaches, important files, and next step into a checkpoint
3. Start a new persistent session and validate its read-only initialization report against the packet and file snapshot
4. On success, return the real new session ID, profile, working directory, and complete `codex resume` command

Run **the resume command actually returned by the tool**. Check `/status` and `/permissions` before continuing development: the read-only initialization permissions may persist, so the profile should not be assumed to restore write access. The current terminal is not replaced automatically.

A real handoff makes a model call through your selected Codex profile/provider and may incur normal usage charges. Review the packet, especially its important-file list, before running it.

> `$auto-handoff` invokes the skill. `/auto-handoff` is not a built-in command registered by this project. Add `--legacy-alias` during installation if you need the older `$auto-handooff` spelling.

## Try a no-account demo

From the repository root, run this without signing in or starting Codex:

```bash
node docs/demo.mjs
```

**Example output, excerpted from the synthetic demo's `preview` object:**

```json
{
  "dry_run": true,
  "profile": "synthetic-demo-no-launch",
  "launches": 0
}
```

The full output includes the checkpoint path, launch arguments, and initialization prompt. The demo uses a temporary project with spaces and Chinese characters in its path. It launches no model and creates no real resumable session ID. Temporary files are retained for inspection.

To try the CLI without a global link, run `node bin/csm.mjs --help` after `npm ci`.

## Capabilities and boundaries

| Capability | Current behavior and limit |
| --- | --- |
| Task context | The skill summarizes the conversation; the CLI validates and saves a packet. It is not a full transcript backup |
| Profile selection | Creation and resume use your explicitly selected profile, with no automatic selection or fallback |
| Read-only initialization | The new session checks the packet and waits for you; it does not begin implementation during initialization |
| Existing work | Keeps the old session and uncommitted changes; does not stage, commit, roll back, or replace the terminal |
| Recovery | Records operations and any new session ID; blocks blind duplicate creation when the result is uncertain |
| Monitoring | Reads explicitly bound logs and gives evidence-backed suggestions; does not trigger a handoff |
| Configuration and statusline | Leaves Codex configuration alone; use native Codex status items and view csm output separately |

“Auto” refers to packet preparation and the initialization workflow. **Creating a new session always requires your explicit choice; a monitoring threshold does not authorize a handoff.**

## Run the CLI manually

To inspect each step or integrate your own workflow, start with the [JSON template](examples/task-state.json) and the [task-state format](skills/auto-handoff/references/task-state.md).

The template defaults to `writers_stopped: false`. Set it to `true` only after you and known background operations have stopped writing. Replace the uppercase placeholders with real values:

```bash
csm checkpoint --session SOURCE_ID --cwd "/path/to/project" --from "/path/to/task-state.json"
csm handoff --session SOURCE_ID --cwd "/path/to/project" --profile YOUR_PROFILE --dry-run
csm handoff --session SOURCE_ID --cwd "/path/to/project" --profile YOUR_PROFILE
```

`--dry-run` previews the launch without creating a model session. A real handoff should stay in the same user, `CODEX_HOME`, session-storage environment, and working directory. Use `--codex` to select a Codex executable.

Retry with the original `--operation-id`. Reuse returns the recorded result without creating another session. If `snapshot_revalidated: false`, check for subsequent project changes. If a new session ID exists or the result is `uncertain`, follow the returned recovery instructions instead of choosing a new operation ID to create another session. See [data and recovery](docs/safety.md).

## Optional monitoring and statusline

Manual handoff does not require monitoring. To monitor, explicitly select a log file you are allowed to read that belongs to the source session:

```bash
csm watch --session SOURCE_ID --cwd "/path/to/project" \
  --source "/path/to/selected-log.jsonl" --once
csm status --session SOURCE_ID --cwd "/path/to/project" --json
```

Remove `--once` to keep polling. The tool checks the log's session ID and working directory; it does not scan session directories for the newest log. Log adaptation is partial and is not guaranteed to work with every Codex TUI version.

- Missing data is `unknown`; estimates and stale observations are explicitly labeled
- Cumulative tokens, cached tokens, and context occupancy are tracked separately
- Recommendations include rules and evidence, without an uncalibrated health score or a claim that high occupancy means worse output
- Rule flags apply to that command invocation and do not change Codex configuration

See [monitoring](docs/monitoring.md) for rules, manual markers, threshold settings, and synthetic replay examples.

For the native Codex statusline, you can manually merge these built-in items into your configuration. If `[tui]` already exists, edit its field instead of adding a duplicate TOML table:

```toml
[tui]
status_line = ["model-with-reasoning", "context-remaining", "current-dir"]
```

csm does not insert custom shell commands into the native statusline or automatically attach to arbitrary existing TUIs. A metric visible in the native UI may still be unavailable to csm. See [statusline compatibility](docs/compatibility.md#原生-statusline).

## Data and safety

- State defaults to `$XDG_STATE_HOME/auto-handoff`, or `~/.local/state/auto-handoff` when XDG is unset. Override it with `--state-dir`; keep task data outside directories you might commit
- Include only what the task needs. Do not include credentials, authentication files, full transcripts, or unrelated personal information. Sensitive-path checks do not replace reviewing the content
- Local packet storage does not make a real handoff offline: its prompt and content read by the new session are processed by the model service in your selected Codex configuration
- The tool does not read authentication files, fabricate session IDs, select sessions with `--last`, bypass approvals, or loosen permissions
- The read-only sandbox primarily constrains local Codex execution. It is not an independent security boundary for every plugin, hook, or remote system; use a trusted Codex configuration

Read [data and recovery](docs/safety.md) for failure states, recovery steps, and additional limitations.

## Development and verification

```bash
npm ci
npm run typecheck
npm run check
npm test
```

The source is TypeScript; the installed runtime uses compiled JavaScript with no third-party runtime dependencies. Tests use isolated temporary directories, synthetic events, and mocked Codex entry points. They need no model account and do not establish that real session creation and resume work end to end.

Further documentation is currently in Chinese: [compatibility](docs/compatibility.md) · [verification record](docs/verification.md) · [monitoring](docs/monitoring.md) · [data and recovery](docs/safety.md) · [skill instructions](skills/auto-handoff/SKILL.md) · [checkpoint format](skills/auto-handoff/references/task-state.md) · [project-page publishing](docs/publishing.md)

## Uninstall

Remove the skill before unlinking the CLI:

```bash
csm uninstall --scope user
npm uninstall --global auto-handoff
```

For a project-level installation, use `csm uninstall --scope project --cwd "/path/to/project"`. Add `--legacy-alias` if you installed it. Uninstall removes only unchanged files recorded by the installer; modified files are kept.

Uninstall does not delete state data or original Codex sessions. Decide separately whether to remove them once they are no longer needed.

## License

No license has been selected. A public repository does not itself grant an open-source license; confirm permission before reuse or distribution.
