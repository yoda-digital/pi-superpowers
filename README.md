# pi-superpowers

A Pi package that brings the [Superpowers](https://github.com/obra/superpowers) methodology to the [Pi coding agent](https://github.com/earendil-works/pi). It bundles the full Superpowers skill set, a bootstrap extension that auto-injects the methodology at session start, a subagent tool for multi-agent workflows, a todo tool for task tracking, native web tools (search, fetch, verify, watch) backed by Tavily, six ready-to-use agent definitions, and a tool mapping reference that bridges Superpowers' action vocabulary to Pi's native tools.

## What's Included

### Extensions

| Extension | File | Purpose |
|---|---|---|
| **Superpowers bootstrap** | `extensions/superpowers.ts` | Injects the `using-superpowers` skill at session start (and after compaction), registers the `skills/` directory for discovery. The bootstrap is deduplicated and re-reads from disk on every injection so edits take effect mid-session. |
| **Subagent tool** | `extensions/subagent/index.ts` | Registers the `subagent` tool with single, parallel (up to 8 tasks, 4 concurrent), and chain modes. Spawns isolated `pi` processes per agent — each gets the agent definition as its system prompt — with JSON-mode streaming, TUI rendering, and usage tracking. |
| **Todo tool** | `extensions/todo.ts` | Registers the `todo` tool and `/todos` TUI command. State is reconstructed from tool-result history so it survives session branching. Supports `add`, `toggle`, `remove`, `rename`, `in_progress`, `list`, and `clear`. |
| **Web tools** | `extensions/web.ts` | Registers `web_search`, `web_fetch`, `web_verify` and `web_watch` (Tavily) and the `/web-key` command. Superpowers' `WebSearch` / `WebFetch` map to these. Subagents whose agent lists a `web_*` tool get them too. See [Web tools](#web-tools-tavily). |

### Agents

Installed to `~/.pi/agent/agents/` by the setup script (or copied there by hand). Used by the `subagent` tool. None of them pins a model: each runs on the parent session's model and thinking level unless you add a `model` field.

| Agent | Tools | Role |
|---|---|---|
| **scout** | read, bash, grep, find, ls | Fast codebase reconnaissance. Maps structure, finds patterns. Read-only. |
| **planner** | read, bash, grep, find, ls | Creates ordered implementation plans with verification steps. Read-only. |
| **implementer** | read, write, edit, bash, grep, find, ls | Executes plan tasks, writes code, runs builds and tests. |
| **reviewer** | read, bash, grep, find, ls | Code review for correctness, security, quality, and plan alignment. Read-only. |
| **debugger** | read, write, edit, bash, grep, find, ls | Systematic debugging: reproduce, investigate, hypothesize, fix, verify. |
| **researcher** | web_search, web_fetch, web_verify, web_watch, read, write | Web research: explores, reads sources, verifies claims, returns a cited report. Needs a Tavily key (`/web-key`). |

### Skills (from Superpowers)

14 skills bundled in `skills/`:

- **using-superpowers** — The bootstrap skill, auto-injected at session start
- **brainstorming** — Explores intent and requirements before implementation
- **writing-plans** — Structured plan creation from specs
- **executing-plans** — Plan execution with review checkpoints
- **subagent-driven-development** — Multi-agent task decomposition
- **dispatching-parallel-agents** — Parallel fan-out for independent tasks
- **test-driven-development** — TDD workflow
- **systematic-debugging** — Investigate-before-fixing discipline
- **requesting-code-review** — Structured review requests
- **receiving-code-review** — Technical rigor when processing review feedback
- **finishing-a-development-branch** — Branch integration decisions
- **using-git-worktrees** — Worktree-based parallel work
- **verification-before-completion** — Evidence before success claims
- **writing-skills** — Meta-skill for creating new skills

### References

| File | Purpose |
|---|---|
| `references/pi-tools.md` | Maps Superpowers action vocabulary (dispatch a subagent, create a todo, etc.) to Pi's native tools. Loaded by the bootstrap extension; falls back to an inline default if the file is missing. |

## Installation

### Option A: `pi install` (recommended for end users)

```bash
pi install git:github.com/yoda-digital/pi-superpowers
```

Then copy the agent definitions:

```bash
mkdir -p ~/.pi/agent/agents
cp ~/.pi/agent/git/github.com/yoda-digital/pi-superpowers/agents/*.md ~/.pi/agent/agents/
```

### Option B: Local checkout (recommended for development)

Pi loads a local package from its path without copying it, so edits take effect on the next session (or `/reload`).

```bash
git clone git@github.com:yoda-digital/pi-superpowers.git ~/gits/pi-superpowers
pi install ~/gits/pi-superpowers

mkdir -p ~/.pi/agent/agents
cp ~/gits/pi-superpowers/agents/*.md ~/.pi/agent/agents/
```

Do not symlink individual extension files into `~/.pi/agent/extensions/`. Pi's loader resolves relative paths from the symlink's location, not the target's, so the bootstrap cannot find `skills/` (it silently injects nothing) and the extensions cannot import their `extensions/lib/` helpers.

### Option C: Per-project (no global install)

```bash
cd /path/to/your/project
pi install -l ~/gits/pi-superpowers   # writes .pi/settings.json

mkdir -p .pi/agents
cp ~/gits/pi-superpowers/agents/*.md .pi/agents/
```

Pi reads `.pi/settings.json` only after you trust the project.

### Option D: Setup script

```bash
git clone git@github.com:yoda-digital/pi-superpowers.git
cd pi-superpowers
./setup.sh
```

The setup script verifies Pi is installed, runs `pi install` on the checkout, copies agent definitions to `~/.pi/agent/agents/` (backing up any existing files), and prints a verification summary.

## Verifying It Works

The acceptance test from the upstream Superpowers project: open a clean Pi session and send exactly this message:

> Let's make a react todo list

A working installation auto-triggers the **brainstorming** skill before any code is written. If Pi jumps straight into writing React components without first exploring requirements and design, the bootstrap is not loading.

What to check:

1. The session should show the `<EXTREMELY_IMPORTANT>` bootstrap block (injected automatically, not typed by you).
2. The agent should invoke the `brainstorming` skill before writing code.
3. The `todo` tool should be available (try asking the agent to track tasks).
4. The `subagent` tool should be available (try `subagent` with `agent: "scout"` and a task).
5. After `/web-key`, ask something current ("what changed in the latest Node.js release?") and the agent should call `web_search`.

## Architecture Overview

```
pi-superpowers/
├── extensions/
│   ├── superpowers.ts          # Bootstrap: injects using-superpowers skill
│   ├── subagent/
│   │   ├── index.ts            # subagent tool registration
│   │   └── agents.ts           # Agent discovery from ~/.pi/agent/agents/ and .pi/agents/
│   ├── todo.ts                 # todo tool + /todos TUI command
│   ├── web.ts                  # web_search / web_fetch / web_verify / web_watch + /web-key
│   └── lib/                    # Pi-independent logic (bootstrap, agent config, child
│                               #   process args, todo state, web/) — what the tests import
├── agents/                     # Agent definition markdown files
│   ├── scout.md
│   ├── planner.md
│   ├── implementer.md
│   ├── reviewer.md
│   ├── debugger.md
│   └── researcher.md
├── skills/                     # 14 Superpowers skills (bundled)
│   ├── using-superpowers/
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── ...
│   └── writing-skills/
├── references/
│   └── pi-tools.md             # Tool mapping: Superpowers actions -> Pi tools
├── tests/                      # node --test suite (imports extensions/lib)
├── package.json                # Pi package manifest
├── setup.sh                    # Installation script
└── README.md
```

### How the pieces fit together

1. **Installation** registers the four extensions with Pi's runtime and makes skills discoverable.

2. **On session start**, the `superpowers.ts` extension fires:
   - Registers `skills/` for skill discovery via the `resources_discover` event.
   - On the first `context` event, reads `skills/using-superpowers/SKILL.md` from disk, wraps it with the `<EXTREMELY_IMPORTANT>` tag and the tool mapping from `references/pi-tools.md`, and injects it as a synthetic user message. This bootstrap is deduplicated (checked by tag presence) and re-injected after compaction.

3. **The bootstrap** tells the agent it has superpowers and teaches it when to invoke each skill. Skills auto-trigger based on task context (brainstorming before creative work, TDD before implementation, systematic-debugging on failures, etc.).

4. **The subagent extension** registers the `subagent` tool, which spawns isolated `pi` child processes (`--no-extensions --no-skills --no-context-files`, so children do not load this package or your AGENTS.md). It discovers agents from `~/.pi/agent/agents/` and the nearest project's `.pi/agents/`. Each child gets its own context window, the agent's body as system prompt, the parent's model unless the agent sets one, and only the tools listed in its frontmatter.

5. **The todo extension** registers the `todo` tool and the `/todos` TUI command. State lives in tool-result details (not external files), so it branches correctly with session history. Every action produces a new immutable snapshot, so later actions never rewrite earlier ones.

6. **The web extension** registers four Tavily-backed tools that run in parallel with other tool calls and are marked read-only/open-world (`web_watch` writes its own state file). Long results are truncated to Pi's limits with the full text saved to a temp file. Children of the `subagent` tool run with `--no-extensions`, so the subagent loads `extensions/web.ts` explicitly (`-e`) for agents that list a `web_*` tool or allow all tools.

7. **The tool mapping** (`references/pi-tools.md`) translates Superpowers' action vocabulary to Pi's tools. When a skill says "dispatch a subagent," the mapping tells the agent to use the `subagent` tool. When it says "create a todo," use the `todo` tool. Web actions map to the `web_*` tools. Core file operations map to Pi's built-in tools; `read`, `write`, `edit` and `bash` are enabled by default, `grep`, `find` and `ls` only when `defaultTools` or `--tools` enables them.

## Configuration

### Agent customization

Agent definitions live in `~/.pi/agent/agents/`. Each is a markdown file with YAML frontmatter:

```yaml
---
name: planner
description: Creates precise implementation plans
tools: read, bash, grep, find, ls
# model: openai/gpt-4o-mini   # optional; omit to inherit the parent's model
---

System prompt content here...
```

Fields:
- **name** (required): How the `subagent` tool references this agent.
- **description** (required): Shown in agent listings.
- **tools** (optional): Comma-separated list of tools the agent can use. Omit to allow all tools.
- **model** (optional): Model override as `provider/id` (e.g. `openai/gpt-4o-mini`). Omit to inherit the parent session's model and thinking level. The provider must be configured in Pi, or the child exits at startup.

The markdown body below the frontmatter is the agent's system prompt. It is appended to the child's system prompt in full.

To customize an agent, edit the file in `~/.pi/agent/agents/`. To add a new agent, create a new `.md` file with the same frontmatter structure.

### Project-local agents

Place agent definitions in `.pi/agents/` within your project. The `subagent` tool searches both user and project agents by default (`agentScope: "both"`); a project agent overrides a user agent with the same name. Pass `agentScope: "user"` or `"project"` to restrict the search. When the project is not trusted, the `subagent` tool asks for confirmation before running project-local agents — but only in interactive sessions; in print/JSON mode it runs them without asking.

### Subagent prompt mode (local models)

By default each child gets the agent's full system prompt and the parent's model. Some local models (observed with Qwen via Ollama) start emitting tool calls as plain text once the system prompt grows. For those, opt into lean mode before starting Pi:

```bash
export PI_SUBAGENT_PROMPT_MODE=lean
```

In lean mode a child gets only a one-line `[Role: name — description]` prefix instead of the agent body, and no `--model` / `--thinking` flags, so it uses the defaults from `settings.json`. The agent's tool restrictions still apply, but its instructions (output format, methodology, the researcher's guide to the web tools) do not reach the model. The subagent result shows the model the child actually used.

### Web tools (Tavily)

The web tools call the [Tavily API](https://docs.tavily.com) and need an API key (free tier available at [app.tavily.com](https://app.tavily.com)). Configure it once, in any of these ways (first match wins):

1. `TAVILY_API_KEY` in the environment Pi starts with.
2. `/web-key tvly-...` in a Pi session (or `/web-key` alone to be prompted). The key is checked with one search (1 credit) and saved to `~/.pi/agent/superpowers/tavily.env` with mode 600.
3. A `TAVILY_API_KEY=tvly-...` line in that file, written by hand.

| Tool | What it does | Credits |
|---|---|---|
| `web_search` | `query`, or `queries` (2-5 phrasings) in parallel, merged by URL with domain consensus. Options: `topic` (`general`/`news`/`finance`), `since`, `depth`, `max_results`, `include_answer`, `include_domains`, `exclude_domains`, `extract_top` (also read the top 1-5 pages), `max_chars` | 1 per query (2 with `depth: "advanced"`), plus extraction |
| `web_fetch` | Reads `urls` (1-20); `intent` returns the parts of each page most relevant to it | 1 per 5 pages (2 advanced) |
| `web_verify` | Evidence summary and sources for a `claim`, and for a `counter` claim when given | 1 per side |
| `web_watch` | First call records a baseline for `name`; later calls return only new sources. State: `~/.pi/agent/superpowers/web-watch/<name>.json` (delete it to reset) | 1 per call |

### Tool mapping

Edit `references/pi-tools.md` to adjust how Superpowers actions map to your Pi environment. If the file is missing, the bootstrap falls back to a built-in inline mapping.

## Running Tests

```bash
npm test          # or: bash tests/run.sh
```

Requires Node.js 22.18 or newer: the tests import the real TypeScript modules in `extensions/lib/` through Node's built-in type stripping, and drive `extensions/superpowers.ts` through a fake Pi host. They cover the bootstrap, agent discovery, how child `pi` processes are built (both prompt modes, web tools in children), the todo state machine, the web tools against a fake Tavily API, and that this README and `references/pi-tools.md` match the code. No Pi installation is required.

The parts that need Pi's runtime (`extensions/subagent/index.ts`, `extensions/todo.ts`, `extensions/web.ts`, `extensions/subagent/agents.ts`) are thin wiring around those modules; check them with `tsc` against Pi's type declarations, and with a real session (see [Verifying It Works](#verifying-it-works)).

## Troubleshooting

### Bootstrap not injecting

- Confirm the package is installed: it must be listed under `packages` in `~/.pi/agent/settings.json` (or `.pi/settings.json` for a per-project install). Symlinked extension files do not work (see Option B).
- Check that `skills/using-superpowers/SKILL.md` exists relative to the package root. The extension reads it from disk on every injection.
- Look for the `<EXTREMELY_IMPORTANT>` tag in the session messages. If it is already present, the bootstrap correctly deduplicates and skips re-injection.

### Skills not auto-triggering

- The bootstrap must be injected first (see above). Without it, skills are discovered but never invoked automatically.
- Verify skills are discovered: use `/skill:` in Pi to list available skills.
- Check that `references/pi-tools.md` exists and is readable. A missing tool mapping means the agent may not know how to invoke Pi's tools when a skill asks it to.

### Web tools fail

- "No Tavily API key configured": run `/web-key` (see [Web tools](#web-tools-tavily)).
- "Tavily API error 401": the key is invalid or revoked; set a new one with `/web-key`.
- Other "Tavily API error …" messages (rate or usage limits) come straight from Tavily; check your account at app.tavily.com.
- A subagent says it has no web tools: its agent's `tools` must list them (e.g. `web_search, web_fetch`).

### Subagent ignores its instructions or prints tool calls as text

- If `PI_SUBAGENT_PROMPT_MODE=lean` is set, agents receive only a role line, not their instructions. Unset it unless your model needs it.
- If you run a local model and the child output contains raw `<tool_call>` text, try `PI_SUBAGENT_PROMPT_MODE=lean`.

### Subagent tool not available

- Confirm `extensions/subagent/index.ts` is loaded (check `~/.pi/agent/extensions/subagent/`).
- The subagent tool spawns `pi` as a child process. If `pi` is not on `PATH`, the tool will fail. Check with `which pi`.

### Agent not found

- Agent files must be in `~/.pi/agent/agents/` (user scope) or `.pi/agents/` (project scope).
- Each file must have valid YAML frontmatter with at least `name` and `description` fields.
- File extension must be `.md`.
- If the call passed `agentScope: "user"`, project agents are not searched (and vice versa).

### Todo state lost

- Todo state is reconstructed from tool-result history in the current branch. If you switch branches, the state reflects that branch's history.
- The `clear` action resets state. There is no undo.

### `pi install` fails with "Could not resolve host"

- Use the full path: `pi install git:github.com/yoda-digital/pi-superpowers` (not just `git:yoda-digital/...`).
- If the repo is private, clone it yourself and install the local checkout (Option B), since `pi install git:` clones via HTTPS without auth.

## Contributing

1. Fork and clone.
2. Make changes to extensions in `extensions/`, agent definitions in `agents/`, or tool mapping in `references/`.
3. Skills in `skills/` are from upstream [Superpowers](https://github.com/obra/superpowers). To modify skills, contribute upstream and sync here.
4. Run `npm test` to verify changes. Put new logic in `extensions/lib/` (no runtime imports from Pi) so the tests can import it.
5. Test with a real Pi session: run the acceptance test ("Let's make a react todo list") and confirm brainstorming auto-triggers.
6. Open a PR with a description of the problem you solved and how you tested.

## License

MIT
