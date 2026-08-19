# pi-superpowers

A Pi package that brings the [Superpowers](https://github.com/superpowers-ai/superpowers) methodology to the [Pi coding agent](https://github.com/earendil-works/pi). It bundles the full Superpowers skill set, a bootstrap extension that auto-injects the methodology at session start, a subagent tool for multi-agent workflows, a todo tool for task tracking, five ready-to-use agent definitions, and a tool mapping reference that bridges Superpowers' Claude Code vocabulary to Pi's native tools.

## What's Included

### Extensions

| Extension | File | Purpose |
|---|---|---|
| **Superpowers bootstrap** | `extensions/superpowers.ts` | Injects the `using-superpowers` skill at session start (and after compaction), registers the `skills/` directory for discovery. The bootstrap is deduplicated and re-reads from disk on every injection so edits take effect mid-session. |
| **Subagent tool** | `extensions/subagent/index.ts` | Registers the `subagent` tool with single, parallel (up to 8 tasks, 4 concurrent), and chain modes. Spawns isolated `pi` processes per agent with JSON-mode streaming, TUI rendering, and usage tracking. |
| **Todo tool** | `extensions/todo.ts` | Registers the `todo` tool and `/todos` TUI command. State is reconstructed from tool-result history so it survives session branching. Supports add, toggle, remove, rename, in\_progress, list, and clear. |

### Agents

Installed to `~/.pi/agents/` by the setup script. Used by the `subagent` tool.

| Agent | Model | Tools | Role |
|---|---|---|---|
| **planner** | claude-sonnet-4-5 | Read, Bash, Grep | Creates ordered implementation plans with verification steps. Read-only. |
| **implementer** | claude-sonnet-4-5 | Read, Write, Edit, Bash, Grep | Executes plan tasks, writes code, runs builds and tests. |
| **reviewer** | claude-sonnet-4-5 | Read, Bash, Grep | Code review for correctness, security, quality, and plan alignment. Read-only. |
| **debugger** | claude-sonnet-4-5 | Read, Write, Edit, Bash, Grep | Systematic debugging: reproduce, investigate, hypothesize, fix, verify. |
| **scout** | claude-haiku-4-5 | Read, Bash, Grep | Fast codebase reconnaissance. Maps structure, finds patterns. Read-only. |

### Skills (from upstream Superpowers)

14 skills loaded from `upstream-superpowers/skills/`:

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

## Quick Install

```sh
git clone <this-repo-url> pi-superpowers
cd pi-superpowers
./setup.sh
```

The setup script verifies Pi is installed, runs `pi install`, copies agent definitions to `~/.pi/agents/` (backing up any existing files), and prints a verification summary.

## Manual Install

If you prefer to install the pieces individually:

1. **Install the package** so Pi loads the extensions and discovers the skills:

   ```sh
   pi install /path/to/pi-superpowers
   ```

2. **Copy agent definitions** to your user agent directory:

   ```sh
   mkdir -p ~/.pi/agents
   cp agents/*.md ~/.pi/agents/
   ```

3. **Verify** by starting Pi and checking that the `subagent` and `todo` tools are available:

   ```sh
   pi
   # In the Pi session, the superpowers bootstrap should inject automatically.
   ```

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
│   │   └── agents.ts           # Agent discovery from ~/.pi/agents/ and .pi/agents/
│   └── todo.ts                 # todo tool + /todos TUI command
├── agents/                     # Agent definition markdown files
│   ├── planner.md
│   ├── implementer.md
│   ├── reviewer.md
│   ├── debugger.md
│   └── scout.md
├── references/
│   └── pi-tools.md             # Tool mapping: Superpowers actions -> Pi tools
├── upstream-superpowers/        # Vendored upstream (skills source)
│   └── skills/                  # 14 SKILL.md files
├── package.json                 # Pi package manifest
├── setup.sh                     # Installation script
└── README.md
```

### How the pieces fit together

1. **`pi install`** reads `package.json` and registers the three extensions with Pi's runtime.

2. **On session start**, the `superpowers.ts` extension fires:
   - Registers `upstream-superpowers/skills/` for skill discovery via the `resources_discover` event.
   - On the first `context` event, reads `upstream-superpowers/skills/using-superpowers/SKILL.md` from disk, wraps it with the `<EXTREMELY_IMPORTANT>` tag and the tool mapping from `references/pi-tools.md`, and injects it as a synthetic user message. This bootstrap is deduplicated (checked by tag presence) and re-injected after compaction.

3. **The bootstrap** tells the agent it has superpowers and teaches it when to invoke each skill. Skills auto-trigger based on task context (brainstorming before creative work, TDD before implementation, systematic-debugging on failures, etc.).

4. **The subagent extension** registers the `subagent` tool, which spawns isolated `pi` child processes. It discovers agents from `~/.pi/agents/` (user scope) and optionally `.pi/agents/` (project scope). Each agent gets its own context window, model assignment, and tool restrictions defined in its frontmatter.

5. **The todo extension** registers the `todo` tool and the `/todos` TUI command. State lives in tool-result details (not external files), so it branches correctly with session history.

6. **The tool mapping** (`references/pi-tools.md`) translates Superpowers' action vocabulary to Pi's tools. When a skill says "dispatch a subagent," the mapping tells the agent to use the `subagent` tool. When it says "create a todo," use the `todo` tool. Core file operations map to Pi's seven built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`).

## Configuration

### Agent customization

Agent definitions live in `~/.pi/agents/`. Each is a markdown file with YAML frontmatter:

```yaml
---
name: planner
description: Creates precise implementation plans
tools: Read,Bash,Grep
model: claude-sonnet-4-5
---

System prompt content here...
```

Fields:
- **name** (required): How the `subagent` tool references this agent.
- **description** (required): Shown in agent listings.
- **tools** (optional): Comma-separated list of tools the agent can use. Omit to allow all tools.
- **model** (optional): Model override. Omit to inherit the parent session's model.

To customize an agent, edit the file in `~/.pi/agents/`. To add a new agent, create a new `.md` file with the same frontmatter structure.

### Project-local agents

Place agent definitions in `.pi/agents/` within your project and invoke the subagent with `agentScope: "both"` or `agentScope: "project"`. Project agents override user agents with the same name. Pi will prompt for confirmation before running project-local agents in untrusted repositories.

### Tool mapping

Edit `references/pi-tools.md` to adjust how Superpowers actions map to your Pi environment. If the file is missing, the bootstrap falls back to a built-in inline mapping.

## Troubleshooting

### Bootstrap not injecting

- Confirm the package is installed: `pi list` should show `pi-superpowers`.
- Check that `upstream-superpowers/skills/using-superpowers/SKILL.md` exists. The extension reads it from disk on every injection.
- Look for the `<EXTREMELY_IMPORTANT>` tag in the session messages. If it is already present, the bootstrap correctly deduplicates and skips re-injection.

### Skills not auto-triggering

- The bootstrap must be injected first (see above). Without it, skills are discovered but never invoked automatically.
- Verify skills are discovered: use `/skill:` in Pi to list available skills.
- Check that `references/pi-tools.md` exists and is readable. A missing tool mapping means the agent may not know how to invoke Pi's tools when a skill asks it to.

### Subagent tool not available

- Confirm `extensions/subagent/index.ts` is listed in the package's `pi.extensions` array and the package is installed.
- The subagent tool spawns `pi` as a child process. If `pi` is not on `PATH`, the tool will fail. Check with `which pi`.

### Agent not found

- Agent files must be in `~/.pi/agents/` (user scope) or `.pi/agents/` (project scope).
- Each file must have valid YAML frontmatter with at least `name` and `description` fields.
- File extension must be `.md`.
- If using project agents, pass `agentScope: "both"` or `agentScope: "project"` to the subagent tool.

### Todo state lost

- Todo state is reconstructed from tool-result history in the current branch. If you switch branches, the state reflects that branch's history.
- The `clear` action resets state. There is no undo.

### Setup script fails at `pi install`

- Ensure Pi is updated to a version that supports the extension API (`@earendil-works/pi-coding-agent`).
- Check that the `pi` command is on your `PATH`.
- Run `pi install /path/to/pi-superpowers` manually to see the full error output.

## Contributing

1. Fork and clone.
2. Make changes. If modifying skills, work in `upstream-superpowers/skills/` and follow the upstream Superpowers contribution guidelines.
3. Test with a real Pi session: run the acceptance test ("Let's make a react todo list") and confirm brainstorming auto-triggers.
4. Open a PR with a description of the problem you solved and how you tested.

## License

MIT
