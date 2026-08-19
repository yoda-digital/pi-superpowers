# pi-superpowers

A Pi package that brings the [Superpowers](https://github.com/obra/superpowers) methodology to the [Pi coding agent](https://github.com/earendil-works/pi). It bundles the full Superpowers skill set, a bootstrap extension that auto-injects the methodology at session start, a subagent tool for multi-agent workflows, a todo tool for task tracking, five ready-to-use agent definitions, and a tool mapping reference that bridges Superpowers' action vocabulary to Pi's native tools.

## What's Included

### Extensions

| Extension | File | Purpose |
|---|---|---|
| **Superpowers bootstrap** | `extensions/superpowers.ts` | Injects the `using-superpowers` skill at session start (and after compaction), registers the `skills/` directory for discovery. The bootstrap is deduplicated and re-reads from disk on every injection so edits take effect mid-session. |
| **Subagent tool** | `extensions/subagent/index.ts` | Registers the `subagent` tool with single, parallel (up to 8 tasks, 4 concurrent), and chain modes. Spawns isolated `pi` processes per agent with JSON-mode streaming, TUI rendering, and usage tracking. |
| **Todo tool** | `extensions/todo.ts` | Registers the `todo` tool and `/todos` TUI command. State is reconstructed from tool-result history so it survives session branching. Supports add, toggle, remove, rename, in\_progress, list, and clear. |

### Agents

Installed to `~/.pi/agent/agents/` by the setup script. Used by the `subagent` tool.

| Agent | Model | Tools | Role |
|---|---|---|---|
| **scout** | claude-haiku-4-5 | read, bash, grep, find, ls | Fast codebase reconnaissance. Maps structure, finds patterns. Read-only. |
| **planner** | claude-sonnet-4-5 | read, grep, find, ls | Creates ordered implementation plans with verification steps. Read-only. |
| **implementer** | claude-sonnet-4-5 | *(all default)* | Executes plan tasks, writes code, runs builds and tests. |
| **reviewer** | claude-sonnet-4-5 | read, bash, grep, find, ls | Code review for correctness, security, quality, and plan alignment. Read-only. |
| **debugger** | claude-sonnet-4-5 | *(all default)* | Systematic debugging: reproduce, investigate, hypothesize, fix, verify. |

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

### Option B: Manual symlink (recommended for development)

This approach lets you edit extensions and see changes immediately without re-installing.

```bash
# 1. Clone the repo
git clone git@github.com:yoda-digital/pi-superpowers.git ~/gits/pi-superpowers
cd ~/gits/pi-superpowers

# 2. Link the superpowers bootstrap extension
mkdir -p ~/.pi/agent/extensions/superpowers
ln -sf "$(pwd)/extensions/superpowers.ts" ~/.pi/agent/extensions/superpowers/index.ts

# 3. Link the subagent extension
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# 4. Link the todo extension
mkdir -p ~/.pi/agent/extensions/todo
ln -sf "$(pwd)/extensions/todo.ts" ~/.pi/agent/extensions/todo/index.ts

# 5. Link the skills directory
ln -sf "$(pwd)/skills" ~/.pi/agent/skills/superpowers

# 6. Copy agent definitions
mkdir -p ~/.pi/agent/agents
cp agents/*.md ~/.pi/agent/agents/
```

### Option C: Per-project (no global install)

For a single project, place extensions in its `.pi/extensions/` directory:

```bash
cd /path/to/your/project
mkdir -p .pi/extensions

# Link just the bootstrap (skills auto-trigger from there)
ln -sf ~/gits/pi-superpowers/extensions/superpowers.ts .pi/extensions/superpowers.ts

# Optionally link subagent and todo
mkdir -p .pi/extensions/subagent
ln -sf ~/gits/pi-superpowers/extensions/subagent/index.ts .pi/extensions/subagent/index.ts
ln -sf ~/gits/pi-superpowers/extensions/subagent/agents.ts .pi/extensions/subagent/agents.ts
ln -sf ~/gits/pi-superpowers/extensions/todo.ts .pi/extensions/todo.ts
```

Note: Project-level extensions require Pi's trust approval on first session.

### Option D: Setup script

```bash
git clone git@github.com:yoda-digital/pi-superpowers.git
cd pi-superpowers
./setup.sh
```

The setup script verifies Pi is installed, attempts `pi install`, copies agent definitions to `~/.pi/agent/agents/` (backing up any existing files), and prints a verification summary.

## Verifying It Works

The acceptance test from the upstream Superpowers project: open a clean Pi session and send exactly this message:

> Let's make a react todo list

A working installation auto-triggers the **brainstorming** skill before any code is written. If Pi jumps straight into writing React components without first exploring requirements and design, the bootstrap is not loading.

What to check:

1. The session should show the `<EXTREMELY_IMPORTANT>` bootstrap block (injected automatically, not typed by you).
2. The agent should invoke the `brainstorming` skill before writing code.
3. The `todo` tool should be available (try asking the agent to track tasks).
4. The `subagent` tool should be available (try `subagent` with `agent: "scout"` and a task).

## Architecture Overview

```
pi-superpowers/
├── extensions/
│   ├── superpowers.ts          # Bootstrap: injects using-superpowers skill
│   ├── subagent/
│   │   ├── index.ts            # subagent tool registration
│   │   └── agents.ts           # Agent discovery from ~/.pi/agent/agents/ and .pi/agents/
│   └── todo.ts                 # todo tool + /todos TUI command
├── agents/                     # Agent definition markdown files
│   ├── scout.md
│   ├── planner.md
│   ├── implementer.md
│   ├── reviewer.md
│   └── debugger.md
├── skills/                     # 14 Superpowers skills (bundled)
│   ├── using-superpowers/
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── ...
│   └── writing-skills/
├── references/
│   └── pi-tools.md             # Tool mapping: Superpowers actions -> Pi tools
├── tests/                      # 163 tests (node --test)
├── package.json                # Pi package manifest
├── setup.sh                    # Installation script
└── README.md
```

### How the pieces fit together

1. **Installation** registers the three extensions with Pi's runtime and makes skills discoverable.

2. **On session start**, the `superpowers.ts` extension fires:
   - Registers `skills/` for skill discovery via the `resources_discover` event.
   - On the first `context` event, reads `skills/using-superpowers/SKILL.md` from disk, wraps it with the `<EXTREMELY_IMPORTANT>` tag and the tool mapping from `references/pi-tools.md`, and injects it as a synthetic user message. This bootstrap is deduplicated (checked by tag presence) and re-injected after compaction.

3. **The bootstrap** tells the agent it has superpowers and teaches it when to invoke each skill. Skills auto-trigger based on task context (brainstorming before creative work, TDD before implementation, systematic-debugging on failures, etc.).

4. **The subagent extension** registers the `subagent` tool, which spawns isolated `pi` child processes. It discovers agents from `~/.pi/agent/agents/` (user scope) and optionally `.pi/agents/` (project scope). Each agent gets its own context window, model assignment, and tool restrictions defined in its frontmatter.

5. **The todo extension** registers the `todo` tool and the `/todos` TUI command. State lives in tool-result details (not external files), so it branches correctly with session history.

6. **The tool mapping** (`references/pi-tools.md`) translates Superpowers' action vocabulary to Pi's tools. When a skill says "dispatch a subagent," the mapping tells the agent to use the `subagent` tool. When it says "create a todo," use the `todo` tool. Core file operations map to Pi's seven built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`).

## Configuration

### Agent customization

Agent definitions live in `~/.pi/agent/agents/`. Each is a markdown file with YAML frontmatter:

```yaml
---
name: planner
description: Creates precise implementation plans
tools: read, grep, find, ls
model: claude-sonnet-4-5
---

System prompt content here...
```

Fields:
- **name** (required): How the `subagent` tool references this agent.
- **description** (required): Shown in agent listings.
- **tools** (optional): Comma-separated list of tools the agent can use. Omit to allow all tools.
- **model** (optional): Model override. Omit to inherit the parent session's model.

To customize an agent, edit the file in `~/.pi/agent/agents/`. To add a new agent, create a new `.md` file with the same frontmatter structure.

### Project-local agents

Place agent definitions in `.pi/agents/` within your project and invoke the subagent with `agentScope: "both"` or `agentScope: "project"`. Project agents override user agents with the same name. Pi will prompt for confirmation before running project-local agents in untrusted repositories.

### Tool mapping

Edit `references/pi-tools.md` to adjust how Superpowers actions map to your Pi environment. If the file is missing, the bootstrap falls back to a built-in inline mapping.

## Running Tests

```bash
bash tests/run.sh
```

Runs 163 tests across 4 test files using Node.js built-in test runner. Tests verify extension logic, agent discovery, todo state management, and package structure. No Pi installation required to run them.

## Troubleshooting

### Bootstrap not injecting

- Confirm the package is installed: check `~/.pi/agent/extensions/` for the symlinks or installed files.
- Check that `skills/using-superpowers/SKILL.md` exists relative to the package root. The extension reads it from disk on every injection.
- Look for the `<EXTREMELY_IMPORTANT>` tag in the session messages. If it is already present, the bootstrap correctly deduplicates and skips re-injection.

### Skills not auto-triggering

- The bootstrap must be injected first (see above). Without it, skills are discovered but never invoked automatically.
- Verify skills are discovered: use `/skill:` in Pi to list available skills.
- Check that `references/pi-tools.md` exists and is readable. A missing tool mapping means the agent may not know how to invoke Pi's tools when a skill asks it to.

### Subagent tool not available

- Confirm `extensions/subagent/index.ts` is loaded (check `~/.pi/agent/extensions/subagent/`).
- The subagent tool spawns `pi` as a child process. If `pi` is not on `PATH`, the tool will fail. Check with `which pi`.

### Agent not found

- Agent files must be in `~/.pi/agent/agents/` (user scope) or `.pi/agents/` (project scope).
- Each file must have valid YAML frontmatter with at least `name` and `description` fields.
- File extension must be `.md`.
- If using project agents, pass `agentScope: "both"` or `agentScope: "project"` to the subagent tool.

### Todo state lost

- Todo state is reconstructed from tool-result history in the current branch. If you switch branches, the state reflects that branch's history.
- The `clear` action resets state. There is no undo.

### `pi install` fails with "Could not resolve host"

- Use the full path: `pi install git:github.com/yoda-digital/pi-superpowers` (not just `git:yoda-digital/...`).
- If the repo is private, use the manual symlink installation (Option B) instead, since `pi install git:` clones via HTTPS without auth.

## Contributing

1. Fork and clone.
2. Make changes to extensions in `extensions/`, agent definitions in `agents/`, or tool mapping in `references/`.
3. Skills in `skills/` are from upstream [Superpowers](https://github.com/obra/superpowers). To modify skills, contribute upstream and sync here.
4. Run `bash tests/run.sh` to verify changes.
5. Test with a real Pi session: run the acceptance test ("Let's make a react todo list") and confirm brainstorming auto-triggers.
6. Open a PR with a description of the problem you solved and how you tested.

## License

MIT
