import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The tag the bootstrap wraps its content in. Also used as the dedup signal:
 * if any message in the conversation already contains this tag, the bootstrap
 * has already been injected and should not be duplicated.
 */
const EXTREMELY_IMPORTANT_TAG = "<EXTREMELY_IMPORTANT>";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "..");
const skillsDir = resolve(packageRoot, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superpowers", "SKILL.md");
const piToolsReferencePath = resolve(packageRoot, "references", "pi-tools.md");

export default function superpowersPiExtension(pi: ExtensionAPI): void {
	let injectBootstrap = true;

	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));

	pi.on("session_start", async () => {
		injectBootstrap = true;
	});

	pi.on("session_compact", async () => {
		injectBootstrap = true;
	});

	pi.on("agent_end", async () => {
		injectBootstrap = false;
	});

	pi.on("context", async (event) => {
		if (!injectBootstrap) return;
		if (event.messages.some(messageContainsBootstrap)) return;

		const bootstrap = buildBootstrapContent();
		if (!bootstrap) return;

		const bootstrapMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: bootstrap }],
			timestamp: Date.now(),
		};

		const insertAt = firstNonCompactionSummaryIndex(event.messages);
		return {
			messages: [
				...event.messages.slice(0, insertAt),
				bootstrapMessage,
				...event.messages.slice(insertAt),
			],
		};
	});
}

// ---------------------------------------------------------------------------
// Bootstrap assembly — re-read from disk on every call (no module-level cache)
// so that SKILL.md edits during a session take effect immediately.
// ---------------------------------------------------------------------------

function buildBootstrapContent(): string | null {
	let skillBody: string;
	try {
		const raw = readFileSync(bootstrapSkillPath, "utf8");
		skillBody = stripFrontmatter(raw);
	} catch {
		return null;
	}

	const toolMapping = loadToolMapping();

	return `${EXTREMELY_IMPORTANT_TAG}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${skillBody}

${toolMapping}
</EXTREMELY_IMPORTANT>`;
}

// ---------------------------------------------------------------------------
// Tool mapping — load from the reference file, fall back to inline default.
// ---------------------------------------------------------------------------

function loadToolMapping(): string {
	try {
		return readFileSync(piToolsReferencePath, "utf8").trim();
	} catch {
		return inlineToolMapping();
	}
}

function inlineToolMapping(): string {
	return `## Pi tool mapping

Pi has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead: load the relevant \`SKILL.md\` with \`read\` when the skill applies, or let a human invoke \`/skill:name\` explicitly.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, \`grep\`, \`find\`, and \`ls\`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi ships \`EnterWorktree\` and \`ExitWorktree\` for git worktree isolation. When a Superpowers instruction calls for worktree-based parallel work, use these tools to enter and exit worktrees.

Pi does not expose a built-in web search or web fetch tool. If an extension or MCP server provides web access, use it; otherwise note the missing capability rather than fabricating calls.

If a \`subagent\` tool (from \`pi-subagents\` or similar) is available, use it for Superpowers subagent workflows. If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.

If an installed todo/task tool (from \`pi-task\` or similar) is available, use it when task tracking is needed. Otherwise track work in plan files or a repo-local \`TODO.md\`. Treat older \`TodoWrite\` references as this task-tracking action.`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function stripFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

/**
 * Dedup check: scan messages for the EXTREMELY_IMPORTANT tag.
 * If any message already contains it, the bootstrap was already injected.
 */
function messageContainsBootstrap(message: unknown): boolean {
	const msg = message as { content?: unknown };
	const content = msg.content;
	if (typeof content === "string") return content.includes(EXTREMELY_IMPORTANT_TAG);
	if (!Array.isArray(content)) return false;
	return content.some((part: unknown) => {
		if (!part || typeof part !== "object") return false;
		const typed = part as { type?: unknown; text?: unknown };
		return (
			typed.type === "text" &&
			typeof typed.text === "string" &&
			typed.text.includes(EXTREMELY_IMPORTANT_TAG)
		);
	});
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
	let index = 0;
	while (
		index < messages.length &&
		(messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary"
	) {
		index += 1;
	}
	return index;
}
