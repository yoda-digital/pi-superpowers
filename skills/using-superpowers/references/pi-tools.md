# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi, with the pi-superpowers package, these resolve to the tools below.

## Core tools

Pi's built-in tools are lowercase. `read`, `write`, `edit` and `bash` are on by default; `grep`, `find` and `ls` only when enabled (`defaultTools` setting or `--tools`). When one is missing from your tool list, do the same through `bash` (`rg`, `find`, `ls`).

## Skills

Pi lists every skill (name, description, location) in your system prompt but has no `Skill` tool. To use a skill, `read` its `SKILL.md`; paths inside a skill are relative to its directory. A human can also run `/skill:name`. Bundled scripts run through their interpreter: `bash <skill-dir>/scripts/foo`.

## Subagents

The `subagent` tool runs each dispatch as a separate `pi` process with a fresh context. Children do not get the Superpowers bootstrap or a `subagent` tool, so they cannot dispatch further subagents. They do get the project's AGENTS.md/CLAUDE.md.

| Action skills request | Pi tool |
|---|---|
| `Subagent (general-purpose):` template | `subagent` with `agent: "general-purpose"`, the template's prompt as `task`, its model as `model` |
| Model by capability: cheap/fast, standard/mid-tier, most capable | `model: "cheap"`, `"mid"` or `"top"` (tiers the user maps with `/subagent-models`; an unmapped tier uses the session's model and the result says so) |
| A specific model or reasoning effort | `model: "provider/id"`, `thinking: "low"`…`"max"` |
| Send a live subagent more work (fix-loop rounds, answers to its questions) | `subagent` with `resume: "<id>"` and the message as `task`. Every result ends with the subagent's id; record it |
| Several independent dispatches | `subagent` with `tasks: [...]`; never parallel implementers on one tree |
| Pipeline where each step needs the last one's output | `subagent` with `chain: [...]`, `{previous}` in a step's task |

Other agents: `scout`, `planner`, `implementer`, `reviewer`, `debugger`, `researcher` (web). Users can add or override agents in `~/.pi/agent/agents/` or the project's `.pi/agents/`.

A `subagent` call blocks until its children finish and returns their reports, so there is nothing to poll, wait on or chase. A timeout (default 60 minutes) ends a hung child and reports it as failed. Running the controller itself one level down, as a nested subagent, is not available on Pi.

Do not fabricate `Task`, `SendMessage` or `spawn_agent` calls. If `subagent` is missing from your tool list, do the work in this session.

## Task tracking

| Action skills request | Pi tool |
|---|---|
| Create a todo (`TodoWrite`) | `todo` with `action: "add"`, `text`, optional `priority` |
| Mark in progress / complete | `todo` with `action: "in_progress"` / `"toggle"` and `id` |
| List, rename, remove, clear | `todo` with `action: "list"`, `"rename"`, `"remove"`, `"clear"` |

## Asking the user

Ask questions in your reply, one at a time. When a skill offers a short menu of options, `ask_user` (`question`, 2-6 `options`) shows them as a picker; the user can still type their own answer.

## Git worktrees

Pi has no worktree tools; use `bash`: `git worktree add <path> -b <branch>`, `git worktree list`, `git worktree remove <path>`. Run later commands with that path as the working directory (or pass it as a subagent's `cwd`).

## Web access

`web_search` (Superpowers' `WebSearch`), `web_fetch` (`WebFetch`), `web_verify` to fact-check a claim, `web_watch` to track new sources on a topic. If one reports that no Tavily key is configured, ask the user to run `/web-key`; do not make results up.

## Brainstorming visual companion

`bash <brainstorming-skill-dir>/scripts/start-server.sh --project-dir <project>` in its default mode: the script backgrounds the server itself and it survives between turns. The URL is in the script's output and in `<project>/.superpowers/brainstorm/<session>/state/server-info`.

## Session transcripts

Pi stores sessions as JSONL. To find and read the current session, its subagents' sessions, or a past one (as `diagnosing-superpowers` asks), read `references/pi-sessions.md` next to the using-superpowers `SKILL.md`.

## Instructions file

"Your instructions file" is `AGENTS.md` (or `CLAUDE.md`) in the project; Pi loads these from the project directory and its ancestors.
