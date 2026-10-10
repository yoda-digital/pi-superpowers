# pi-superpowers

A Pi package that brings the [Superpowers](https://github.com/obra/superpowers) methodology to the [Pi coding agent](https://github.com/earendil-works/pi), built on Pi's own extension APIs.

It contains:
- the full Superpowers skill set, vendored unmodified from upstream (currently **v7.0.0**, pinned in `UPSTREAM.json`)
- a bootstrap that puts the methodology in Pi's system prompt
- a subagent tool built for Superpowers' dispatch patterns: per-dispatch model tiers, resuming a subagent with its context, parallel and chained runs
- a todo tool and an `ask_user` picker
- native web tools backed by Tavily
- seven agent definitions
- a Pi tool reference that maps Superpowers' action vocabulary to these tools

## Compared to upstream's own Pi support

Upstream Superpowers ships a small Pi extension that injects the bootstrap and registers the skills, and leaves subagents and task tracking to third-party packages. This package goes further:

| | upstream `.pi/` extension | pi-superpowers |
|---|---|---|
| Bootstrap | Request-local user message, dropped after the first exchange | System prompt section, on every run, recorded in the session, cache-friendly |
| Subagent children | Get the controller's bootstrap | Marked as children; no bootstrap, no nested dispatch |
| `Subagent (general-purpose)` templates | Need a third-party tool | `general-purpose` agent |
| "cheap / standard / most capable model" | — | `model: "cheap" \| "mid" \| "top"`, mapped to your models |
| SDD fix loop "resume the implementer" | — | `resume: "<id>"` |
| Todo, ask-user, web | — | `todo`, `ask_user`, `web_*` |
| Diagnosing a session | Model guesses the transcript format | `pi-sessions.md` documents Pi's session files and where subagent transcripts are |

## What's included

### Extensions

| Extension | File | Purpose |
|---|---|---|
| **Superpowers bootstrap** | `extensions/superpowers.ts` | Puts the `using-superpowers` skill plus the Pi tool mapping into the system prompt as a `<superpowers>` section, on every run. Skills are registered by the package manifest. |
| **Subagent tool** | `extensions/subagent/index.ts` | Registers the `subagent` tool and the `/subagent-models` command. Modes: single, resume, parallel, chain. Each child is an isolated `pi` process with its own persisted session. See [Subagents](#subagents). |
| **Todo tool** | `extensions/todo.ts` | Registers the `todo` tool and the `/todos` view. State is rebuilt from tool-result history, so it follows session branching. Actions: `add`, `toggle`, `remove`, `rename`, `in_progress`, `list`, `clear`. Progress shows in pi-statusbar when installed, otherwise in Pi's footer. |
| **Ask user** | `extensions/ask.ts` | Registers `ask_user`: one multiple-choice question as an arrow-key picker, with a "type my own" option. For the moments a skill offers a short menu. |
| **Web tools** | `extensions/web.ts` | Registers `web_search`, `web_fetch`, `web_verify` and `web_watch` (Tavily), plus the `/web-key` command. See [Web tools](#web-tools-tavily). |

### Agents

They ship in the package's `agents/` directory and update with the package. None pins a model: each runs on the dispatch's `model`, otherwise the parent session's model.

| Agent | Tools | Role |
|---|---|---|
| **general-purpose** | all | Runs any task. The target of Superpowers' `Subagent (general-purpose)` templates (implementer, reviewers, builder check, analysts). |
| **scout** | read, bash, grep, find, ls | Fast codebase reconnaissance. Read-only. |
| **planner** | read, bash, grep, find, ls | Ordered implementation plans with verification steps. Read-only. |
| **implementer** | read, write, edit, bash, grep, find, ls | Executes plan tasks, writes code, runs builds and tests. |
| **reviewer** | read, bash, grep, find, ls | Code review for correctness, security, quality and plan alignment. Read-only. |
| **debugger** | read, write, edit, bash, grep, find, ls | Systematic debugging: reproduce, investigate, hypothesize, fix, verify. |
| **researcher** | web_search, web_fetch, web_verify, web_watch, read, write | Web research with a cited report. Needs a Tavily key (`/web-key`). |

### Skills (from Superpowers v7.0.0)

- **using-superpowers**: the bootstrap skill, always in the system prompt
- **brainstorming**: works out what you want before anything is built, sizes the work, builder-checks the design
- **writing-plans**: lean plans that record decisions, with a Review Focus section
- **executing-plans**: native inline execution with a ledger and one final review
- **subagent-driven-development**: one implementer per task, a review after each, a resume-based fix loop
- **dispatching-parallel-agents**: parallel fan-out for independent problems
- **test-driven-development**: RED-GREEN-REFACTOR, with the project suite defining green
- **systematic-debugging**: root cause before fixes
- **requesting-code-review** and **receiving-code-review**
- **finishing-a-development-branch**
- **using-git-worktrees**
- **verification-before-completion**: evidence before claims
- **diagnosing-superpowers**: figures out what went wrong in a session, with `path:line` evidence
- **writing-skills**

### References

| File | Purpose |
|---|---|
| `references/pi-tools.md` | Maps Superpowers actions (dispatch a subagent, pick a model tier, resume, create a todo, …) to Pi tools. Part of the bootstrap. |
| `references/pi-sessions.md` | Where Pi keeps session and subagent transcripts and how to read them. Loaded on demand, for example by `diagnosing-superpowers`. |

Both are also copied into `skills/using-superpowers/references/`, replacing upstream's Pi reference there.

## Installation

### Option A: `pi install` (recommended for end users)

```bash
pi install git:github.com/yoda-digital/pi-superpowers
```

That is all; update with `pi update --extensions`.

### Option B: Local checkout (recommended for development)

Pi loads a local package from its path without copying it, so edits take effect on the next session (or `/reload`).

```bash
git clone git@github.com:yoda-digital/pi-superpowers.git ~/gits/pi-superpowers
pi install ~/gits/pi-superpowers
```

Do not symlink individual extension files into `~/.pi/agent/extensions/`. Pi's loader resolves relative paths from the symlink's location, not the target's, so the bootstrap cannot find `skills/` and the extensions cannot import their `extensions/lib/` helpers.

### Option C: Per-project (no global install)

```bash
cd /path/to/your/project
pi install -l ~/gits/pi-superpowers   # writes .pi/settings.json
```

Pi reads `.pi/settings.json` only after you trust the project.

### Option D: Setup script

```bash
git clone git@github.com:yoda-digital/pi-superpowers.git
cd pi-superpowers
./setup.sh
```

The setup script checks that Pi is installed, runs `pi install` on the checkout and prints a verification summary. If `~/.pi/agent/agents/` holds copies of the package agents from an older install, it removes the unchanged ones (they would block updates) and warns about modified ones (they override the package version).

Do not install upstream Superpowers' own Pi extension alongside this package: both would register the same skills.

## Verifying it works

Upstream's acceptance test: open a clean Pi session and send exactly

> Let's make a react todo list

A working installation triggers the **brainstorming** skill before any code is written. Then send a second, unrelated request (for example "add a settings page"). It should go through the skills too, since the bootstrap is present on every run, not only the first.

Also check:

1. `todo`, `subagent` and `ask_user` are in the tool list.
2. `subagent` with `agent: "scout"` and a task returns a report ending in `[continue this subagent with its context: subagent { "resume": "scout-…" …}]`. A follow-up with that `resume` id remembers the first exchange.
3. After `/web-key`, a current-events question ("what changed in the latest Node.js release?") makes the agent call `web_search`.

## How it works

```
pi-superpowers/
├── extensions/
│   ├── superpowers.ts          # bootstrap → system prompt section
│   ├── subagent/
│   │   ├── index.ts            # subagent tool, /subagent-models
│   │   └── agents.ts           # agent discovery: package, user, project
│   ├── todo.ts                 # todo tool, /todos
│   ├── ask.ts                  # ask_user tool
│   ├── web.ts                  # web_* tools, /web-key
│   └── lib/                    # Pi-independent logic the tests import: bootstrap,
│                               #   agent config, child args and output, model tiers,
│                               #   process runner and session store, todo state, web/
├── agents/                     # agent definitions (markdown + frontmatter)
├── skills/                     # vendored upstream skills + Pi overlay (do not edit)
├── references/                 # pi-tools.md, pi-sessions.md (the overlay's source)
├── scripts/sync-upstream.sh    # re-vendor skills from obra/superpowers
├── UPSTREAM.json               # the upstream ref and commit skills/ comes from
└── tests/                      # node --test suite, with a fake `pi` for the runner
```

1. **Bootstrap.**
   - On every `before_agent_start`, `superpowers.ts` reads `skills/using-superpowers/SKILL.md` and `references/pi-tools.md` and sets them as the `superpowers` system prompt section.
   - Pi records the prompt in the session and replays it after compaction, resume and branch navigation.
   - An unchanged section is not re-recorded, so the provider's prompt cache stays warm. An edited `SKILL.md` takes effect on the next prompt.
   - Processes started by the `subagent` tool carry `PI_SUPERPOWERS_CHILD=1`, and the bootstrap stays out of them.

2. **Skills** are declared in the package manifest (`pi.skills`). Pi lists them in the system prompt and the model loads one with `read` when it applies. Users can still turn individual skills off through Pi's package resource filters.

3. **Subagents.** See [Subagents](#subagents).

4. **Todo.**
   - State lives in tool-result details, not external files, so it branches with the session.
   - Every action produces a new immutable snapshot.

5. **Web tools.**
   - Read-only, parallel-safe Tavily calls.
   - Long results are truncated to Pi's limits and the full text is saved to a temp file.

6. **Tool mapping.** `references/pi-tools.md` translates Superpowers' action vocabulary into Pi tools. For example, a `Subagent (general-purpose)` dispatch becomes `subagent` with `agent: "general-purpose"`, and "most capable model" becomes `model: "top"`.

## Subagents

```
subagent { agent: "general-purpose", task: "...", model: "mid" }        single
subagent { resume: "general-purpose-3fa9c1d2", task: "Fix: ..." }       resume
subagent { tasks: [{ agent, task, model? }, ...] }                       parallel
subagent { chain: [{ agent, task: "... {previous} ..." }, ...] }         chain
```

**Each child process:**
- runs `pi --mode json -p --no-extensions --no-skills --no-themes`;
- gets the task on stdin, so there is no argv size limit;
- has its own session in `~/.pi/agent/superpowers/subagent-sessions/<parent-session-id>/`;
- gets the project's AGENTS.md/CLAUDE.md, unless the agent sets `contextFiles: false`;
- inherits the parent's project-trust decision (`--approve` or `--no-approve`), but only when its `cwd` is inside the parent's project; elsewhere it gets `--no-approve`;
- has only the tools its agent lists. Children never get the `subagent` tool, so there is no nested dispatch;
- gets the web tools loaded explicitly (`-e`) when its agent lists a `web_*` tool or allows all tools.

**Results:**
- Each result ends with a footer naming the child's id, model and usage, and how to resume it.
- Children's token usage is reported to Pi, so it counts toward the session totals.
- The parent session stores a summary of each child (final output, a capped list of its tool calls, usage), not its full transcript. The transcript stays in the child's own session file.

**Resume** reopens the child's session with the same agent, model and working directory and sends `task` as the next message. This is what subagent-driven development's fix loop asks for: rounds 1-3 send review findings back to the same implementer, context intact. Children can be resumed across `/new` and restarts. A child that is still running cannot be resumed a second time in parallel. Child sessions of a parent that has not dispatched or resumed anything for `sessionRetentionDays` are deleted at session start.

**Model selection.** The precedence is:
1. the dispatch's `model`;
2. the agent's `model` frontmatter;
3. the parent session's model.

Each of these can be a tier (`cheap`, `mid`, `top`) or a `provider/id`. A tier that is not mapped falls back to the parent's model, and the result says so. `thinking` works the same way. The parent's thinking level is inherited only when the child runs the parent's model.

**Timeouts and failures.**
- A child that runs past `timeoutMinutes` gets SIGTERM, then SIGKILL, and is reported as failed with its partial output.
- Spawn errors, non-zero exits and model errors (`stopReason: "error"`) are reported as failures with the reason.

### Settings: `~/.pi/agent/superpowers/subagents.json`

```json
{
  "tiers": { "cheap": "ollama/qwen3:8b", "mid": "ollama/qwen3:32b", "top": "ollama/qwen3:32b" },
  "concurrency": 2,
  "maxParallelTasks": 8,
  "timeoutMinutes": 60,
  "sessionRetentionDays": 14
}
```

All fields are optional. The defaults are no tiers (everything uses the session model), concurrency 4, 8 parallel tasks, 60 minutes (0 disables the timeout) and 14 days (0 keeps child sessions forever). `/subagent-models` picks the three tiers from your configured models and writes the file. With a single local model server, set `concurrency` to the number of requests it actually serves at once; extra children only queue.

### Agent definitions

The `subagent` tool reads agent definitions from three places, from least to most specific:

| Source | Directory | Shown as |
|---|---|---|
| Package | `agents/` inside this package (updates with `pi update --extensions`) | `package` |
| User | `~/.pi/agent/agents/` | `user` |
| Project | nearest `.pi/agents/` up from the working directory | `project` |

An agent in a more specific place replaces a less specific one with the same `name`, and listings say so, for example `scout (user, overrides package)`. An override stops receiving package updates for that agent; delete it to go back to the package version.

```yaml
---
name: planner
description: Creates precise implementation plans
tools: read, bash, grep, find, ls   # optional; omit to allow all tools
model: mid                          # optional; a tier or provider/id
thinking: high                      # optional
contextFiles: false                 # optional; keep AGENTS.md/CLAUDE.md out of the child
---

System prompt content here...
```

The markdown body is appended to the child's system prompt. To customize a package agent, copy it to `~/.pi/agent/agents/` (or a project's `.pi/agents/`) and edit the copy.

By default (`agentScope: "both"`) the tool uses package, user and project agents. `agentScope: "user"` restricts it to package and user agents; `"project"` restricts it to project agents. When the project is not trusted, the tool asks before running project-local agents. It asks only in interactive sessions; in print/JSON mode it runs them without asking.

### Prompt mode for local models

Some local models (observed with Qwen via Ollama) emit tool calls as plain text once the system prompt grows. For those, opt into lean mode before starting Pi:

```bash
export PI_SUBAGENT_PROMPT_MODE=lean
```

In lean mode a child gets only a one-line `[Role: name — description]` prefix instead of the agent body. Unless the dispatch or agent names a model, it uses the defaults from `settings.json`. Tool restrictions still apply, but the agent's instructions do not reach the model.

## Web tools (Tavily)

The web tools call the [Tavily API](https://docs.tavily.com) and need an API key (free tier at [app.tavily.com](https://app.tavily.com)). Configure it once, in any of these ways (first match wins):

1. `TAVILY_API_KEY` in the environment Pi starts with.
2. `/web-key tvly-...` in a Pi session (or `/web-key` alone to be prompted). The key is checked with one search (1 credit) and saved to `~/.pi/agent/superpowers/tavily.env` with mode 600.
3. A `TAVILY_API_KEY=tvly-...` line in that file, written by hand.

| Tool | What it does | Credits |
|---|---|---|
| `web_search` | `query`, or `queries` (2-5 phrasings) in parallel, merged by URL with domain consensus. Options: `topic` (`general`/`news`/`finance`), `since`, `depth`, `max_results`, `include_answer`, `include_domains`, `exclude_domains`, `extract_top` (also read the top 1-5 pages), `max_chars` | 1 per query (2 with `depth: "advanced"`), plus extraction |
| `web_fetch` | Reads `urls` (1-20); `intent` returns the parts of each page most relevant to it | 1 per 5 pages (2 advanced) |
| `web_verify` | Evidence summary and sources for a `claim`, and for a `counter` claim when given | 1 per side |
| `web_watch` | First call records a baseline for `name`; later calls return only new sources. State: `~/.pi/agent/superpowers/web-watch/<name>.json` (delete it to reset) | 1 per call |

## Updating the skills from upstream

```bash
npm run sync-upstream              # re-sync the ref in UPSTREAM.json
bash scripts/sync-upstream.sh v7.1.0   # move to another upstream tag or commit
```

The script replaces `skills/` with upstream's tree at that ref, copies `references/*.md` over `skills/using-superpowers/references/`, and records the ref and commit in `UPSTREAM.json`. Never edit `skills/` by hand. Pi-specific guidance belongs in `references/`, so a sync never needs a merge. After a sync, check the release notes for new capabilities the skills ask of the harness and map them in `references/pi-tools.md`.

## Running tests

```bash
npm test          # or: bash tests/run.sh
```

This needs Node.js 22.18 or newer: the tests import the real TypeScript modules in `extensions/lib/` through Node's built-in type stripping. No Pi installation is required. The suite covers:
- the bootstrap, driven through a fake Pi host;
- agent discovery and model-tier resolution;
- child argv and output parsing;
- the child process runner, against `tests/fixtures/fake-pi.mjs`: stdin delivery, JSONL framing, timeouts, SIGKILL escalation, spawn errors and abort;
- the child session store;
- the todo state machine;
- the web tools, against a fake Tavily API;
- that this README, `references/` and the vendored skills agree with the code.

The Pi-bound wiring (`extensions/*.ts`, `extensions/subagent/*.ts`) is checked with `tsc` against Pi's type declarations and with a real session (see [Verifying it works](#verifying-it-works)).

## Troubleshooting

### Skills do not trigger

- The package must be listed under `packages` in `~/.pi/agent/settings.json` (or the project's `.pi/settings.json`). Symlinked extension files do not work (see Option B).
- The session file shows whether the bootstrap is present: the first `system` message has a `superpowers` key in `sections`.
- `/skill:` lists the discovered skills.

### Web tools fail

- "No Tavily API key configured": run `/web-key` (see [Web tools](#web-tools-tavily)).
- "Tavily API error 401": the key is invalid or revoked. Set a new one with `/web-key`.
- Other "Tavily API error …" messages (rate or usage limits) come straight from Tavily; check your account at app.tavily.com.
- A subagent says it has no web tools: its agent's `tools` must list them (for example `web_search, web_fetch`).

### Subagent problems

- **"could not start the child process"**: the tool runs Pi's own executable (`process.execPath` with Pi's script), and `pi` on `PATH` only as a last resort. The error message names the cause.
- **A tier is "not configured"**: map it with `/subagent-models` or in `subagents.json`.
- **"No subagent with id … to resume"**: the child's session was pruned or the id is mistyped. Dispatch a fresh one. Resume also refuses when the child's agent no longer exists or its working directory is gone.
- **Ignores its instructions, or prints tool calls as text**: if `PI_SUBAGENT_PROMPT_MODE=lean` is set, agents receive only a role line; unset it unless your model needs it. If a local model emits raw `<tool_call>` text, try lean mode.
- **Unknown agent**: custom agent files go in `~/.pi/agent/agents/` or `.pi/agents/`, need `name` and `description` frontmatter, and end in `.md`. With `agentScope: "user"` project agents are not searched; with `"project"`, package and user agents are not.
- **Times out**: raise `timeoutMinutes`, or lower `concurrency` if a local model server is queueing children.

### Todo state lost

- Todo state is rebuilt from tool-result history on the current branch. Switching branches shows that branch's history.
- `clear` resets the state. There is no undo.

### `pi install` fails with "Could not resolve host"

- Use the full path: `pi install git:github.com/yoda-digital/pi-superpowers` (not `git:yoda-digital/...`).
- If the repo is private, clone it yourself and install the local checkout (Option B), since `pi install git:` clones over HTTPS without auth.

## Contributing

1. Fork and clone.
2. Change extensions in `extensions/`, agents in `agents/`, or Pi guidance in `references/`. Skills come from upstream [Superpowers](https://github.com/obra/superpowers): contribute there, then run `npm run sync-upstream`.
3. Put new logic in `extensions/lib/` (no runtime imports from Pi) so the tests can import it, and run `npm test`.
4. Test with a real Pi session: run the acceptance test and confirm brainstorming triggers.
5. Open a PR describing the problem you solved and how you tested it.

## License

MIT
