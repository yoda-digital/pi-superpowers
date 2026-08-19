# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

## Core Tools

Pi's seven built-in coding tools are lowercase. They are always available.

| Action skills request | Pi tool |
|---|---|
| Read a file | `read` |
| Create a new file | `write` |
| Edit a file (targeted patch) | `edit` |
| Run a shell command | `bash` |
| Search file contents (regex) | `grep` |
| Find files by name / pattern | `find` |
| List a directory | `ls` |

## Subagents

The `subagent` tool is available from this package's companion extension (`extensions/subagent/`). Use it for all Superpowers subagent workflows.

| Action skills request | Pi tool |
|---|---|
| Dispatch a subagent (`Subagent (general-purpose):` template) | `subagent` with `agent` + `task` (single mode) |
| Parallel fan-out | `subagent` with `tasks` array (up to 8 tasks, 4 concurrent) |
| Sequential chain | `subagent` with `chain` array (`{previous}` placeholder carries output forward) |

Modes:
- **Single:** `{ agent: "name", task: "..." }`
- **Parallel:** `{ tasks: [{ agent: "name", task: "..." }, ...] }`
- **Chain:** `{ chain: [{ agent: "name", task: "... {previous} ..." }, ...] }`

Agent scope defaults to `"user"` (agents defined in `~/.pi/agents/`). Set `agentScope: "both"` or `"project"` to include project-local agents from `.pi/agents/`.

Do not fabricate `Task` or `SendMessage` calls. If the `subagent` tool is somehow unavailable (extension not loaded), do the work in the current session.

## Task Tracking

The `todo` tool is available from this package's companion extension (`extensions/todo.ts`). Use it for all task-tracking needs.

| Action skills request | Pi tool |
|---|---|
| Create a todo / track a task | `todo` with `action: "add"`, `text`, optional `priority` (low/medium/high) |
| List todos | `todo` with `action: "list"` |
| Mark a task complete | `todo` with `action: "toggle"`, `id` |
| Mark a task in progress | `todo` with `action: "in_progress"`, `id` |
| Remove a task | `todo` with `action: "remove"`, `id` |
| Rename a task | `todo` with `action: "rename"`, `id`, `text` |
| Clear all tasks | `todo` with `action: "clear"` |

Treat older `TodoWrite` / `TodoRead` references as the `todo` tool actions above.

## Git Worktrees

Pi does not ship dedicated worktree tools like Claude Code's `EnterWorktree` / `ExitWorktree`. Use `bash` with standard git commands:

| Action skills request | Pi equivalent |
|---|---|
| Create an isolated worktree | `bash`: `git worktree add <path> -b <branch>` |
| Switch the session to a worktree | `bash`: `cd <worktree-path>` (set cwd) |
| Clean up a worktree | `bash`: `git worktree remove <path>` |
| List worktrees | `bash`: `git worktree list` |

When a Superpowers skill (e.g. `using-git-worktrees`) checks for native worktree tools, Pi has none -- the skill's Step 1b git-command fallback applies.

## Skills

Pi has native skill support. Skills are loaded from `SKILL.md` files discovered via the extension's `resources_discover` event.

| Action skills request | Pi equivalent |
|---|---|
| Invoke a skill | Human runs `/skill:name`; or agent reads the relevant `SKILL.md` with `read` |
| Load skill content | `read` the `SKILL.md` file directly |

Pi does not expose Claude Code's `Skill` tool. When a Superpowers instruction says to invoke a skill, use Pi's native `/skill:name` system or read the SKILL.md file.

## Web Access

Pi does not ship built-in web search or web fetch tools. These capabilities depend on extensions or MCP servers.

| Action skills request | Pi equivalent |
|---|---|
| Fetch a URL / read a webpage | Extension or MCP tool if available; otherwise note the missing capability |
| Search the web | Extension or MCP tool if available; otherwise note the missing capability |

Do not fabricate `WebSearch` or `WebFetch` calls. If no web tool is available, say so.

## Instructions File

When a skill mentions "your instructions file," on Pi this is **`AGENTS.md`** in the project directory (preferred), or **`CLAUDE.md`** as fallback. Pi loads these hierarchically from ancestor directories.

## Graceful Degradation

The core seven tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) are always present. `subagent` and `todo` are provided by this package's companion extensions and are available whenever the package is installed. For everything else:

| Capability | If unavailable |
|---|---|
| Web fetch / search | Note the missing capability; do not fabricate tool calls |
| Git worktrees | Use `bash` with git commands (always works) |
| MCP servers | Check what is available; do not assume |
