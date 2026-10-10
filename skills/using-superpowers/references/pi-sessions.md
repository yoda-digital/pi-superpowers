# Pi session transcripts

Where Pi keeps session transcripts and how to read them, for `diagnosing-superpowers` and anything else that inspects past work.

## Locations

| What | Path |
|---|---|
| Interactive sessions | `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session-id>.jsonl`. `<cwd>` is the working directory without its leading `/`, with `/`, `\` and `:` replaced by `-`; for example `/home/me/app` → `--home-me-app--` |
| Subagent children | `~/.pi/agent/superpowers/subagent-sessions/<parent-session-id>/<timestamp>_<child-id>.jsonl`, plus `<child-id>.subagent.json` (agent, model, thinking, cwd, parent session id) |

`PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting relocates interactive sessions. The `subagent` tool's result names each child's id, and the child's file contains that id.

**The current session:** the newest file in the current directory's session folder is usually it. Confirm it by matching recent user messages. The parent session id is the header `id`; its subagents are in the directory with that name.

## Format

One JSON object per line. Line 1 is the header: `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`, plus `parentSession` (a file path) for forks. Every later entry has `type`, `id`, `parentId` and an ISO `timestamp`. The entries form a tree: a branch is a new child of an earlier entry, and the active conversation is the path from the last entry back to the root.

| `type` | Meaning |
|---|---|
| `message` | `message.role` is one of: `system` (the prompt; the first one has every section, later ones patch `sections` by name), `user`, `assistant` (`content` holds `text`, `thinking` and `toolCall` parts; also `provider`, `model`, `usage`, `stopReason`, `errorMessage`), `toolResult` (`toolName`, `toolCallId`, `content`, `isError`), `custom`, `bashExecution` |
| `compaction` | Older context was summarized: `summary`, `firstKeptEntryId`, `tokensBefore` |
| `branch_summary` | Summary of a branch the user navigated away from |
| `model_change`, `thinking_level_change` | User switched model or thinking level |
| `custom`, `custom_message` | Extension state; `customType` names the extension |
| `context_edit` | A later edit hiding or replacing an earlier entry's content |
| `usage` | Model usage recorded outside an assistant message (for example a tool's own model calls) |
| `label`, `session_info` | Bookmarks and the session name |

What to look for:

- Whether Superpowers was loaded: the first `system` message has a `superpowers` key in `sections`, holding the bootstrap.
- Which skills were used: `read` tool calls on `…/SKILL.md` files, or user messages starting with `<skill name=…>` (from `/skill:name`).
- Subagent dispatches: `toolCall` parts with `name: "subagent"`. The matching `toolResult` ends with `[continue this subagent with its context: subagent { "resume": "<id>", … }]`, and its `details.results[].sessionFile` is the child's transcript.
- Compaction recaps: `custom_message` entries with `customType` `superpowers-todo-recap` or `superpowers-subagent-recap`, right after a `compaction` entry.
- Cost: sum `usage.cost.total` over assistant messages. Subagent cost is in the children's files and in the `subagent` tool result's `usage`.

Transcripts can be large. Measure first (`wc -lc`), find the long lines (`awk 'length > 100000 {print NR}'`), and pull single lines with `sed -n '<N>p' <file> | jq …` instead of reading whole files.
