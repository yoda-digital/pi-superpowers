# pi-superpowers

[Superpowers](https://github.com/obra/superpowers) for the [Pi coding agent](https://github.com/earendil-works/pi), built on Pi's own extension APIs.

Superpowers is a set of skills that makes a coding agent work like a careful engineer: brainstorm before building, write a plan, test first, debug from the root cause, get reviewed, verify before claiming it's done. Upstream ships a small Pi extension that loads the skills. That's enough to read them, but not enough to run the workflows at full strength. The skills expect subagents they can resume, a model choice per dispatch, a todo list, and a bootstrap that stays put for the whole session. This package provides all of that natively in Pi, and it's tuned to work on local models as well as hosted ones.

Version 2.3.0 vendors Superpowers v7.0.0 (pinned in `UPSTREAM.json`).

## Quick start

```bash
pi install git:github.com/yoda-digital/pi-superpowers
```

Start Pi and run `/superpowers`. It checks the bootstrap, the skills, the tools, the subagent model tiers and the web key, and tells you how to fix anything that's off. Two things you'll probably want to set up once:

- `/subagent-models` maps the `cheap`, `mid` and `top` tiers that the skills ask for to models you have. Until you do, every subagent runs on your session's model.
- `/web-key` stores a [Tavily](https://app.tavily.com) key for the web tools.

Then try upstream's acceptance test: in a clean session, send `Let's make a react todo list`. The agent should load the brainstorming skill and start asking what you want before it writes any code.

Update with `pi update --extensions`.

## What's in the package

### Extensions

| File | What it registers |
|---|---|
| `extensions/superpowers.ts` | The bootstrap: the `using-superpowers` skill and the Pi tool mapping, as a `<superpowers>` section of the system prompt on every run. Also the `/superpowers` status command. |
| `extensions/subagent/index.ts` | The `subagent` tool (single, resume, parallel, chain) and `/subagent-models`. See [Subagents](#subagents). |
| `extensions/todo.ts` | The `todo` tool (`add`, `toggle`, `in_progress`, `rename`, `remove`, `list`, `clear`) and the `/todos` view. Progress shows in pi-statusbar if you have it, otherwise in Pi's footer. |
| `extensions/ask.ts` | `ask_user`, a question card for the moments a skill offers a short menu. See [Asking questions](#asking-questions). |
| `extensions/web.ts` | `web_search`, `web_fetch`, `web_verify` and `web_watch` (Tavily), and `/web-key`. See [Web tools](#web-tools-tavily). |

### Agents

Agent definitions live in `agents/` and update with the package. None of them pins a model.

| Agent | Tools | Role |
|---|---|---|
| `general-purpose` | all | Runs any task. Superpowers' `Subagent (general-purpose)` dispatch templates (implementer, reviewers, builder check, analysts) map to it. |
| `scout` | read, bash, grep, find, ls | Quick read-only reconnaissance of a codebase |
| `planner` | read, bash, grep, find, ls | Ordered implementation plans with verification steps, read-only |
| `implementer` | read, write, edit, bash, grep, find, ls | Carries out plan tasks and runs the builds and tests |
| `reviewer` | read, bash, grep, find, ls | Read-only review for correctness, security and plan alignment |
| `debugger` | read, write, edit, bash, grep, find, ls | Reproduce, investigate, fix, verify |
| `researcher` | web_search, web_fetch, web_verify, web_watch, read, write | Web research with a cited report. Needs a Tavily key. |

### Skills

All 15 Superpowers v7.0.0 skills, unmodified: using-superpowers (always loaded through the bootstrap), brainstorming, writing-plans, executing-plans, subagent-driven-development, dispatching-parallel-agents, test-driven-development, systematic-debugging, requesting-code-review, receiving-code-review, finishing-a-development-branch, using-git-worktrees, verification-before-completion, diagnosing-superpowers and writing-skills.

### References

`references/pi-tools.md` translates the actions the skills ask for into Pi tools, for example "dispatch a subagent on the most capable model" into `subagent` with `model: "top"`. It's part of the bootstrap, so the model always has it. `references/pi-sessions.md` explains where Pi keeps session and subagent transcripts and how to read them. The model loads it when it needs it, mostly for diagnosing-superpowers. Both files are copied into `skills/using-superpowers/references/`, where they replace upstream's Pi reference.

## How this differs from upstream's Pi extension

| | upstream `.pi/` extension | pi-superpowers |
|---|---|---|
| Bootstrap | A request-local user message. Pi never stores it, and the extension stops injecting it after the first exchange, so from the second prompt on the model works without it. | A system prompt section, set on every run and recorded in the session |
| Subagent children | Get the controller's bootstrap | Run without it, and can't dispatch subagents of their own |
| `Subagent (general-purpose)` templates | Need a third-party package | `general-purpose` agent |
| "Use a cheap / standard / most capable model" | Not available | `model: "cheap" \| "mid" \| "top"`, mapped to your models |
| SDD fix loop: "resume the implementer" | Not available | `resume: "<id>"` |
| Todo list, ask the user, web | Not available | `todo`, `ask_user`, `web_*` |
| State after compaction | Nothing to keep (no todo or subagent tools) | Open todos and resumable subagent ids are re-attached |
| Diagnosing a past session | The model guesses the transcript format | `pi-sessions.md` documents it |

Don't install upstream's Pi extension next to this one. Both register the same skills.

## How it works

```
pi-superpowers/
├── extensions/
│   ├── superpowers.ts          bootstrap section, /superpowers
│   ├── subagent/index.ts       subagent tool, /subagent-models
│   ├── subagent/agents.ts      agent discovery: package, user, project
│   ├── todo.ts                 todo tool, /todos
│   ├── ask.ts                  ask_user
│   ├── web.ts                  web_* tools, /web-key
│   └── lib/                    the logic, with no runtime imports from Pi, so the
│                               tests run it directly
├── agents/                     agent definitions
├── skills/                     upstream skills plus the Pi overlay (never edit by hand)
├── references/                 pi-tools.md and pi-sessions.md, the overlay's source
├── scripts/                    sync-upstream.sh, eval-skills.mjs, typecheck.sh
├── UPSTREAM.json               which upstream ref and commit skills/ came from
└── tests/                      node --test suite, including a fake `pi`
```

The bootstrap is set in Pi's `before_agent_start` event as the `superpowers` section of the system prompt. Pi stores the prompt in the session and replays it after compaction, resume and branch navigation. An unchanged section isn't recorded again, so it doesn't break the provider's prompt cache. If you edit `SKILL.md`, the change shows up on your next prompt. Processes started by the `subagent` tool carry `PI_SUPERPOWERS_CHILD=1`, and the bootstrap skips them.

Skills are declared in `package.json` (`pi.skills`). Pi lists each skill's name and description in the system prompt, and the model reads a `SKILL.md` when one applies. You can switch individual skills off with Pi's package resource filters.

Compaction would normally wipe out two things the workflows depend on: the todo list, and the ids of subagents the model may need to resume. After each compaction, the todo and subagent extensions append a short recap with the open todos and the recent subagents. The recap goes after the compaction point, so the compacted part of the prompt stays cacheable.

The tools follow a few rules:

- Each one declares MCP-style `annotations` (read-only, destructive, open-world) that permission extensions can act on.
- `subagent` and `todo` return typed `structuredContent` next to their text, so codemode scripts get data instead of prose.
- `todo` calls run one at a time, since they share a list.
- Only you can approve a project-local agent. The model has no parameter that skips that confirmation.
- Web results arrive labelled as third-party content, so instructions hidden in a page are read as data.

## Asking questions

Skills ask open questions in plain chat, and you answer by typing as usual. When a skill offers a short menu instead (brainstorming when you're stuck, or finishing-a-development-branch's merge / PR / keep / discard), the model calls `ask_user` and Pi shows a card where the editor normally is:

```
╭─ ? Question ────────────────────────────────────────────────────────────╮
│ How do you want to finish this branch?                                  │
│ Tests pass; the branch is 3 commits ahead of main.                      │
│                                                                         │
│ ▌1  Merge into main                                       ★ recommended │
│     Fast-forward main, then delete the branch.                          │
│  2  Open a pull request                                                 │
│  3  Keep the branch                                                     │
│  ✎  Something else…                                                     │
│                                                                         │
│ ↑↓ move · 1-3 pick · ⏎ choose · tab note · esc skip                     │
╰─────────────────────────────────────────────────────────────────────────╯
```

A number key answers straight away. The arrows (or `j`/`k`) and Enter work too, and the cursor starts on the option the model recommends, so Enter alone accepts it. "Something else…" opens a text field inside the card for your own answer. `tab` attaches a note to whatever you're picking, so "SQLite" can come back as "SQLite, but enable WAL mode". With `multiple`, the options get checkboxes: digits or space toggle them and Enter submits. In Pi's fullscreen mode you can also click an option or scroll with the wheel. Esc skips the question, and the model is told to ask in the chat if it still needs the answer.

Answers and notes can be as long as you like. Paste with your terminal's usual shortcut (`Ctrl+V` in Windows Terminal, `Ctrl+Shift+V` in most Linux terminals, right-click in Pi's fullscreen mode); the newlines survive, Windows line endings are cleaned up, and a long paste shows as a compact `[paste #1 +40 lines]` marker that expands when you send it. Pasting while the option list has focus opens "Something else" with your text in it. Pi's own clipboard key (`Ctrl+V`, or `Alt+V` on Windows and WSL) also works, for terminals that don't paste on `Ctrl+V` themselves. To start a new line while typing, use `Ctrl+J` (or `Shift+Enter` where your terminal supports it).

Once you answer, the card collapses into one line in the conversation (`✓ SQLite`, plus the note if you wrote one, and "+N lines" when the answer is longer), and the model gets your full answer as text and as typed data. The card adapts to the terminal width and drops its border below 32 columns. While it waits, Pi reports to terminals that support OSC 7501 that it's blocked on a dialog. RPC clients get Pi's native picker instead, and without any interactive user the tool tells the model to ask in its reply.

## Subagents

```
subagent { agent: "general-purpose", task: "...", model: "mid" }        single
subagent { resume: "general-purpose-3fa9c1d2", task: "Fix: ..." }       resume
subagent { tasks: [{ agent, task, model? }, ...] }                       parallel
subagent { chain: [{ agent, task: "... {previous} ..." }, ...] }         chain
```

Each child is a separate process: `pi --mode json -p --no-extensions --no-skills --no-themes`. It gets the task on stdin, so long tasks don't hit the argv size limit. It keeps its session in `~/.pi/agent/superpowers/subagent-sessions/<parent-session-id>/` so you can resume it later.

What a child can do is narrower than what its parent can do:

- It gets the project's AGENTS.md or CLAUDE.md, unless its agent sets `contextFiles: false`.
- It inherits the parent's project trust (`--approve` or `--no-approve`), but only when its working directory is inside the parent's project. Anywhere else it runs with `--no-approve`.
- It only has the tools its agent lists, and never the `subagent` tool, so subagents can't spawn subagents.
- If its agent lists a `web_*` tool or allows all tools, the web extension is loaded into it explicitly.

Every result ends with a footer naming the child's id, model and token usage, plus the exact call to resume it. The children's usage counts toward your session totals. The parent session stores a summary of each child (final answer, a capped list of tool calls, usage) and leaves the full transcript in the child's own session file.

Resume reopens a child's session with the same agent, model and working directory and sends `task` as its next message. Subagent-driven development needs this: in fix rounds 1 to 3, the review findings go back to the same implementer, which still has its context. You can resume a child after `/new` or a restart. You can't resume one that's still running. Child sessions belonging to a parent that hasn't dispatched or resumed anything for `sessionRetentionDays` are deleted when a session starts.

A child's model comes from the first of these that is set: the dispatch's `model`, the agent's `model` frontmatter, the parent session's model. Each can be a tier (`cheap`, `mid`, `top`) or a `provider/id`. If a tier isn't mapped, the child falls back to the session's model and the result says so. `thinking` works the same way. A child inherits the parent's thinking level only when it runs the parent's model, because a level picked for one model can be wrong for another.

A child that runs longer than `timeoutMinutes` gets SIGTERM, then SIGKILL, and is reported as failed along with its partial output. Spawn errors, non-zero exits and model errors (`stopReason: "error"`) also come back as failures, with the reason.

### Settings

`~/.pi/agent/superpowers/subagents.json`, every field optional:

```json
{
  "tiers": { "cheap": "ollama/qwen3:8b", "mid": "ollama/qwen3:32b", "top": "ollama/qwen3:32b" },
  "concurrency": 2,
  "maxParallelTasks": 8,
  "timeoutMinutes": 60,
  "sessionRetentionDays": 14
}
```

Without the file you get no tiers (everything runs on the session model), 4 children at once, at most 8 tasks per parallel call, a 60-minute timeout and 14 days of retention. A timeout of 0 turns it off, and 0 days keeps child sessions forever. `/subagent-models` writes the tiers for you from the models Pi knows about. If you run one local model server, set `concurrency` to the number of requests it really serves in parallel. Extra children just wait in its queue.

### Agent definitions

The tool looks for agents in three places. A more specific one replaces a less specific one with the same `name`:

| Source | Directory | Shown as |
|---|---|---|
| Package | `agents/` in this package | `package` |
| User | `~/.pi/agent/agents/` | `user` |
| Project | the nearest `.pi/agents/` above the working directory | `project` |

Listings show the replacement, for example `scout (user, overrides package)`. An override no longer gets package updates. Delete it to go back to the package version. To customize a package agent, copy it to `~/.pi/agent/agents/` and edit the copy.

```yaml
---
name: planner
description: Creates precise implementation plans
tools: read, bash, grep, find, ls   # optional; leave it out to allow every tool
model: mid                          # optional; a tier or provider/id
thinking: high                      # optional
contextFiles: false                 # optional; keeps AGENTS.md/CLAUDE.md out of the child
---

The agent's instructions. They're appended to the child's system prompt.
```

By default (`agentScope: "both"`) the tool searches all three places. `"user"` limits it to package and user agents, and `"project"` limits it to project agents. In a project you haven't trusted, the tool asks you before it runs a project-local agent, and before it resumes one. It can only ask in an interactive session. In print or JSON mode it runs them without asking.

### Lean prompts for local models

Some local models (we've seen it with Qwen on Ollama) start writing tool calls as plain text once the system prompt gets long. If yours does, set this before starting Pi:

```bash
export PI_SUBAGENT_PROMPT_MODE=lean
```

In lean mode a child gets a one-line `[Role: name — description]` prefix instead of the agent's instructions. Unless the dispatch or agent names a model, it uses the defaults from `settings.json`. Tool restrictions still apply.

## Web tools (Tavily)

The web tools call the [Tavily API](https://docs.tavily.com). The free tier is enough to start. The key is looked up in this order:

1. `TAVILY_API_KEY` in Pi's environment.
2. `~/.pi/agent/superpowers/tavily.env`, which `/web-key tvly-...` writes (mode 600) after checking the key with one search. `/web-key` on its own prompts for the key.
3. A `TAVILY_API_KEY=tvly-...` line you add to that file yourself.

| Tool | What it does | Credits |
|---|---|---|
| `web_search` | `query`, or 2 to 5 `queries` run in parallel and merged by URL. Options: `topic` (`general`, `news`, `finance`), `since`, `depth`, `max_results`, `include_answer`, `include_domains`, `exclude_domains`, `extract_top` (also read the top 1 to 5 pages), `max_chars` | 1 per query, 2 with `depth: "advanced"`, plus extraction |
| `web_fetch` | Reads 1 to 20 `urls`. With `intent`, returns the parts of each page that matter for it. | 1 per 5 pages, 2 when advanced |
| `web_verify` | Evidence and sources for a `claim`, and for a `counter` claim if you give one | 1 per side |
| `web_watch` | The first call records a baseline under `name`, and later calls return only new sources. It's the one web tool that writes something: its state in `~/.pi/agent/superpowers/web-watch/<name>.json` (delete the file to reset). | 1 per call |

Long results are cut to Pi's output limits, and the full text is saved to a temp file whose path is in the result.

## Keeping up with upstream

```bash
npm run sync-upstream                    # re-sync the ref in UPSTREAM.json
bash scripts/sync-upstream.sh v7.1.0     # move to another tag or commit
```

The script swaps `skills/` for upstream's tree at that ref, copies `references/*.md` into `skills/using-superpowers/references/`, and records the ref and commit in `UPSTREAM.json`. Nothing Pi-specific lives inside `skills/`, so a sync never needs a merge. After one, read upstream's release notes for anything new the skills expect from the harness, and map it in `references/pi-tools.md`.

## Evals

```bash
npm run eval                                              # every case, your default model
node scripts/eval-skills.mjs --case react-todo --runs 3 --model ollama/qwen3:32b
```

`scripts/eval-skills.mjs` runs real Pi sessions in throwaway projects, with this package loaded the way you installed it. Each case is graded twice:

- A probe extension records whether every request sent to the model carried the bootstrap. This part doesn't depend on the model.
- The tool calls must show the right skill's `SKILL.md` being read before the first file change.

| Case | What it checks |
|---|---|
| `react-todo` | Upstream's acceptance test: brainstorming before any code |
| `second-prompt` | A second prompt in the same running session still has the bootstrap and still triggers the skill |
| `failing-test` | A failing `npm test` leads to systematic-debugging before any edit |
| `near-miss` | A plain question gets an answer and no file changes |

The probe matters more than it looks. Pi's skill list carries upstream's description of brainstorming, and a capable model will load the skill from that alone. So the behavioral check passed even against the old code that lost the bootstrap. The probe failed it. Model behavior also varies from run to run, so use `--runs N` for a pass rate. The grading itself is unit-tested in `tests/eval-grading.test.mjs`.

## Tests and type checks

```bash
npm test             # node --test, no Pi needed (Node.js 22.18+)
npm run typecheck    # tsc against the installed Pi's declarations
```

The tests import the real modules in `extensions/lib/` through Node's built-in TypeScript type stripping, and drive the bootstrap extension through a fake Pi host. The subagent runner is tested end to end against `tests/fixtures/fake-pi.mjs`: stdin delivery, JSONL framing, timeouts, SIGKILL escalation, spawn errors and abort. Other tests cover:

- agent discovery and model tiers
- the child session store
- the todo state machine and the compaction recaps
- the `ask_user` card: every key path, layout at widths from 12 to 100 columns, mouse rows, the result text
- the `/superpowers` report and the web tools against a fake Tavily
- that this README, `references/` and the vendored skills agree with the code

`npm run typecheck` copies `extensions/` to a temporary directory and checks it against the Pi you have installed. It works on a copy because a `node_modules` inside this package would get in the way of how Pi loads it.

## Troubleshooting

**Skills don't trigger.** Run `/superpowers` first. Then check that the package is listed under `packages` in `~/.pi/agent/settings.json` (or the project's `.pi/settings.json`). Symlinked extension files don't work, because Pi resolves their imports from the symlink's location. A session file shows whether the bootstrap was there: its first `system` message has a `superpowers` key in `sections`. `/skill:` lists the skills Pi found.

**Web tools fail.** "No Tavily API key configured" means you need `/web-key`. "Tavily API error 401" means the key is invalid or revoked. Other Tavily errors, such as rate or usage limits, come straight from Tavily, so check your account. A subagent with no web tools needs them listed in its agent's `tools`.

**Subagents misbehave:**

- "could not start the child process": the tool runs Pi's own executable (Node plus Pi's script), and only falls back to `pi` on `PATH` as a last resort. The message gives the cause.
- A tier is "not configured": map it with `/subagent-models` or in `subagents.json`.
- "No subagent with id … to resume": the session was pruned or the id is wrong, so dispatch a fresh one. Resume also refuses when the child's agent no longer exists or its working directory is gone.
- The child ignores its instructions: check whether `PI_SUBAGENT_PROMPT_MODE=lean` is set, because in lean mode agents get only a role line.
- The child prints raw `<tool_call>` text: that's a local model struggling with a long prompt. Try lean mode.
- "Unknown agent": agent files go in `~/.pi/agent/agents/` or `.pi/agents/`, end in `.md`, and need `name` and `description` in their frontmatter. Check `agentScope` as well.
- Timeouts: raise `timeoutMinutes`, or lower `concurrency` if your model server is queueing children.

**Todos disappeared.** The list is rebuilt from the `todo` results on the current branch, so switching branches shows that branch's list. `clear` can't be undone.

**`pi install` says "Could not resolve host".** Use the full source, `git:github.com/yoda-digital/pi-superpowers`. For a private fork, clone it yourself and `pi install` the local path, since `pi install git:` clones over HTTPS without credentials.

## Development

Pi loads a local package straight from its path, so a checkout is the easiest way to work on this:

```bash
git clone git@github.com:yoda-digital/pi-superpowers.git ~/gits/pi-superpowers
pi install ~/gits/pi-superpowers        # or: pi install -l ... for one project
```

Edits take effect in the next session, or after `/reload`. `./setup.sh` does the install for you and checks the result. Older versions copied the agents into `~/.pi/agent/agents/`, where a copy overrides the package version. The script removes copies that were never changed and warns about modified ones.

Some rules for changes:

- Logic goes in `extensions/lib/`, with no runtime imports from Pi, so the tests can run it directly.
- Pi guidance goes in `references/`.
- Skills come from upstream: change them there, then run `npm run sync-upstream`.

Before opening a PR, run `npm test`, `npm run typecheck`, and the acceptance test in a real session.

## License

MIT
