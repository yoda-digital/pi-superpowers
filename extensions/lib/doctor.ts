/**
 * The /superpowers status report: what is installed, what is active, what is
 * missing, and what to do about it.
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 */

export interface DoctorInput {
	packageVersion?: string;
	upstream?: { ref?: string; commit?: string };
	/** Bootstrap section text, or null when using-superpowers cannot be read. */
	bootstrap: string | null;
	skillNames: string[];
	activeTools: string[];
	tiers: Partial<Record<"cheap" | "mid" | "top", string>>;
	settingsError?: string;
	/** Child sessions kept for resume under the current parent session. */
	childSessions: number;
	tavilyKey: boolean;
	sessionModel?: string;
}

const PACKAGE_TOOLS = ["subagent", "todo", "ask_user", "web_search", "web_fetch", "web_verify", "web_watch"] as const;

/** One line per check, prefixed ✓ (fine), ! (works, with a caveat) or ✗ (broken), then fixes. */
export function buildDoctorReport(input: DoctorInput): { lines: string[]; problems: number } {
	const lines: string[] = [];
	let problems = 0;
	const ok = (text: string) => lines.push(`✓ ${text}`);
	const warn = (text: string) => lines.push(`! ${text}`);
	const fail = (text: string) => {
		problems++;
		lines.push(`✗ ${text}`);
	};

	const up = input.upstream?.ref ? ` (Superpowers ${input.upstream.ref}${input.upstream.commit ? ` @ ${input.upstream.commit.slice(0, 7)}` : ""})` : "";
	lines.push(`pi-superpowers ${input.packageVersion ?? "?"}${up}`);

	if (input.bootstrap) ok(`bootstrap in the system prompt (${Math.round(input.bootstrap.length / 1000)}k chars, every run)`);
	else fail("bootstrap missing: skills/using-superpowers/SKILL.md cannot be read — reinstall the package");

	const n = input.skillNames.length;
	if (n > 0 && input.skillNames.includes("using-superpowers")) ok(`${n} skills: ${input.skillNames.join(", ")}`);
	else fail(`skills not found in the package (${n})`);

	const inactive = PACKAGE_TOOLS.filter((t) => !input.activeTools.includes(t));
	if (inactive.length === 0) ok(`tools active: ${PACKAGE_TOOLS.join(", ")}`);
	else warn(`tools not active: ${inactive.join(", ")} (disabled by --tools/defaultTools, or an extension failed to load)`);

	if (input.settingsError) fail(`subagent settings ignored: ${input.settingsError}`);
	const tierText = (["cheap", "mid", "top"] as const)
		.map((t) => `${t}=${input.tiers[t] ?? `(session: ${input.sessionModel ?? "?"})`}`)
		.join(", ");
	const anyTier = Object.keys(input.tiers).length > 0;
	(anyTier ? ok : warn)(`subagent tiers: ${tierText}${anyTier ? "" : " — map them with /subagent-models"}`);
	ok(`${input.childSessions} resumable subagent session${input.childSessions === 1 ? "" : "s"} for this session`);

	if (input.tavilyKey) ok("Tavily key configured (web tools ready)");
	else warn("no Tavily key: web tools will refuse — run /web-key");

	return { lines, problems };
}
