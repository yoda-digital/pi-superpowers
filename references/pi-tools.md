# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

## Core Tools

Pi's built-in coding tools are lowercase. `read`, `write`, `edit` and `bash` are enabled by default; `grep`, `find` and `ls` exist but are enabled only through the `defaultTools` setting or `--tools`. Use the tools in your tool list; when `grep`, `find` or `ls` is missing, do the same through `bash`.

| Action skills request | Pi tool |
|---|---|
| Read a file | `read` |
| Create a new file | `write` |
| Edit a file (targeted patch) | `edit` |
| Run a shell command | `bash` |
| Search file contents (regex) | `grep` if enabled, else `bash` (`rg` / `grep -rn`) |
| Find files by name / pattern | `find` if enabled, else `bash` (`find` / `fd`) |
| List a directory | `ls` if enabled, else `bash` (`ls`) |

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

Agent scope defaults to `"both"`: user agents from `~/.pi/agent/agents/` plus the nearest project's `.pi/agents/`, where a project agent overrides a user agent with the same name. Set `agentScope: "user"` or `"project"` to restrict the search.

Each subagent runs as a separate `pi` process with the agent definition's full body as its system prompt, the parent session's model and thinking level (unless the agent pins its own `model`), and only the tools listed in its `tools` field. When `PI_SUBAGENT_PROMPT_MODE=lean` is set, children get only a one-line role prefix and resolve their model from `settings.json` — an opt-in for local models whose tool calling degrades with longer prompts.

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

This package's web extension (`extensions/web.ts`) provides Tavily-backed web tools. They need a Tavily API key: the user runs `/web-key`, sets `TAVILY_API_KEY`, or puts it in `~/.pi/agent/superpowers/tavily.env`.

| Action skills request | Pi tool |
|---|---|
| Search the web (`WebSearch`) | `web_search` with `query`; `queries` (2-5 phrasings) for parallel searches with domain consensus; `topic: "news"` + `since` for recent news; `extract_top` to also read the top results |
| Fetch a URL / read a webpage (`WebFetch`) | `web_fetch` with `urls`; `intent` returns the most relevant parts of each page |
| Fact-check a claim | `web_verify` with `claim` (and optional `counter`) |
| Monitor a topic over time | `web_watch` with `query` and `name`: first call is a baseline, later calls return only new sources |

If a web tool reports that no key is configured, tell the user to run `/web-key`; do not fabricate results.

## Instructions File

When a skill mentions "your instructions file," on Pi this is **`AGENTS.md`** in the project directory (preferred), or **`CLAUDE.md`** as fallback. Pi loads these hierarchically from ancestor directories.

## Graceful Degradation

`read`, `write`, `edit` and `bash` are enabled by default; `grep`, `find` and `ls` only when `defaultTools` or `--tools` enables them. `subagent`, `todo` and the `web_*` tools are provided by this package's extensions and are available whenever the package is installed (the web tools also need a Tavily key). For everything else:

| Capability | If unavailable |
|---|---|
| Web fetch / search (no Tavily key) | Ask the user to run `/web-key`; do not fabricate results |
| `grep` / `find` / `ls` not enabled | Use `bash` |
| Git worktrees | Use `bash` with git commands |
| MCP servers | Check what is available; do not assume |
