import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOOTSTRAP_SECTION, buildBootstrapContent, isSubagentChild } from "./lib/bootstrap.ts";
import { buildDoctorReport } from "./lib/doctor.ts";
import { loadSettings } from "./lib/subagent-config.ts";
import { childSessionDir } from "./lib/subagent-run.ts";
import { resolveTavilyKey, tavilyKeyFile } from "./lib/web/tavily.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = resolve(packageRoot, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superpowers", "SKILL.md");
const piToolsReferencePath = resolve(packageRoot, "references", "pi-tools.md");

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Puts the using-superpowers bootstrap into the system prompt as its own
 * section. Skills are registered by the package manifest (`pi.skills`).
 *
 * Pi rebuilds the prompt options for every run, so the section is set on every
 * `before_agent_start`. Pi records the prompt in the session and replays it
 * after compaction, resume and branch navigation; an unchanged section is not
 * re-recorded and keeps the provider's prompt cache warm.
 */
export default function superpowersPiExtension(pi: ExtensionAPI): void {
	if (isSubagentChild(process.env)) return;

	pi.on("before_agent_start", (event) => {
		const bootstrap = buildBootstrapContent(bootstrapSkillPath, piToolsReferencePath);
		if (bootstrap) event.systemPromptOptions.sections[BOOTSTRAP_SECTION] = bootstrap;
		else delete event.systemPromptOptions.sections[BOOTSTRAP_SECTION];
	});

	pi.registerCommand("superpowers", {
		description: "Show the Superpowers integration status: bootstrap, skills, tools, subagent tiers, web key",
		handler: async (_args, ctx) => {
			// Imported here, not at the top: the module must load without Pi so the tests run the real extension.
			const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
			const agentDir = getAgentDir();
			const { settings, error } = loadSettings(join(agentDir, "superpowers", "subagents.json"));
			const childDir = childSessionDir(join(agentDir, "superpowers", "subagent-sessions"), ctx.sessionManager.getSessionId());
			let childSessions = 0;
			try {
				childSessions = readdirSync(childDir).filter((f) => f.endsWith(".subagent.json")).length;
			} catch {
				/* none yet */
			}
			let tavilyKey = false;
			try {
				tavilyKey = Boolean(resolveTavilyKey(process.env, tavilyKeyFile(agentDir)));
			} catch {
				/* not configured */
			}
			const upstream = readJson(join(packageRoot, "UPSTREAM.json"));
			const { lines, problems } = buildDoctorReport({
				packageVersion: readJson(join(packageRoot, "package.json"))?.version as string | undefined,
				upstream: upstream as { ref?: string; commit?: string } | undefined,
				bootstrap: buildBootstrapContent(bootstrapSkillPath, piToolsReferencePath),
				skillNames: readdirSync(skillsDir)
					.filter((d) => existsSync(join(skillsDir, d, "SKILL.md")))
					.sort(),
				activeTools: pi.getActiveTools(),
				tiers: settings.tiers,
				settingsError: error,
				childSessions,
				tavilyKey,
				sessionModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			});
			ctx.ui.notify(lines.join("\n"), problems > 0 ? "error" : "info");
		},
	});
}
