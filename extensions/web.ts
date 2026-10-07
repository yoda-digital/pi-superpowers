/**
 * Web tools — Tavily-backed search, page extraction, claim verification and
 * topic watching as native Pi tools, plus /web-key to store the API key.
 *
 * The logic lives in ./lib/web/ (tested without Pi); this file binds it to
 * Pi's tool API, truncation and rendering.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	getAgentDir,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createTavilyClient, resolveTavilyKey, saveTavilyKey, tavilyKeyFile } from "./lib/web/tavily.ts";
import { MAX_QUERIES, runFetch, runSearch, runVerify, runWatch, type WebToolOutput } from "./lib/web/tools.ts";

const NAMESPACE = { name: "web", description: "Web search, page extraction and claim verification (Tavily)" };
const READ_ONLY = { readOnlyHint: true, openWorldHint: true };

const Depth = StringEnum(["basic", "advanced"] as const, { description: '"advanced" finds better sources and costs 2 credits instead of 1. Default "basic".' });
const Topic = StringEnum(["general", "news", "finance"] as const, { description: 'Search category. Default "general".' });
const Since = StringEnum(["day", "week", "month", "year"] as const, { description: "Only results from this recent period." });
const MaxResults = Type.Integer({ minimum: 1, maximum: 20, description: "Results per query, 1-20. Default 5." });
const Domains = (what: string) => Type.Array(Type.String(), { description: `${what}, e.g. ["docs.python.org"].` });
const SnippetChars = Type.Integer({ minimum: 0, description: "Snippet characters per result. Default 300; 0 hides snippets." });

const SearchParams = Type.Object({
	query: Type.Optional(Type.String({ description: "What to search for." })),
	queries: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_QUERIES,
			description: `2-${MAX_QUERIES} phrasings searched in parallel. Results are merged by URL and ranked; domains found by several phrasings are listed as consensus.`,
		}),
	),
	topic: Type.Optional(Topic),
	since: Type.Optional(Since),
	depth: Type.Optional(Depth),
	max_results: Type.Optional(MaxResults),
	include_answer: Type.Optional(Type.Boolean({ description: "Add a short AI-generated answer from the results." })),
	include_domains: Type.Optional(Domains("Only search these domains")),
	exclude_domains: Type.Optional(Domains("Never return these domains")),
	extract_top: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, description: "Also return the full text of the top N results (0-5). Default 0." })),
	max_chars: Type.Optional(SnippetChars),
});

const FetchParams = Type.Object({
	urls: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "Pages to read (1-20 URLs)." }),
	intent: Type.Optional(Type.String({ description: "What you are looking for; returns the most relevant parts of each page." })),
	depth: Type.Optional(Depth),
	max_chars: Type.Optional(Type.Integer({ minimum: 0, description: "Characters per page. Default 4000; 0 hides content." })),
});

const VerifyParams = Type.Object({
	claim: Type.String({ description: "The statement to check." }),
	counter: Type.Optional(Type.String({ description: "The opposing statement, searched separately." })),
	depth: Type.Optional(Depth),
	since: Type.Optional(Since),
	max_results: Type.Optional(MaxResults),
	include_domains: Type.Optional(Domains("Only search these domains")),
	exclude_domains: Type.Optional(Domains("Never return these domains")),
	max_chars: Type.Optional(SnippetChars),
});

const WatchParams = Type.Object({
	query: Type.String({ description: "Topic to monitor." }),
	name: Type.Optional(Type.String({ description: "Watch id (letters, digits, . _ -). Default: derived from the query." })),
	topic: Type.Optional(Topic),
	since: Type.Optional(Since),
	max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Results checked per call. Default 10." })),
	max_chars: Type.Optional(SnippetChars),
});

export default function webExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const keyFile = tavilyKeyFile(agentDir);
	const watchDir = join(agentDir, "superpowers", "web-watch");

	// Resolved per call so /web-key takes effect without a restart.
	const client = () => createTavilyClient({ fetch: globalThis.fetch, apiKey: resolveTavilyKey(process.env, keyFile) });

	/** Model-facing result: truncated to Pi's limits, full text saved to a temp file when cut. */
	async function toResult<D>(out: WebToolOutput<D>) {
		const t = truncateHead(out.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		let text = t.content;
		if (t.truncated) {
			const dir = await mkdtemp(join(tmpdir(), "pi-web-"));
			const file = join(dir, "output.md");
			await withFileMutationQueue(file, () => writeFile(file, out.text, "utf8"));
			text += `\n\n[Output truncated to ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}. Full output: ${file}]`;
		}
		return { content: [{ type: "text" as const, text }], details: out.details };
	}

	const title = (theme: { fg(c: string, s: string): string; bold(s: string): string }, name: string, arg: string) =>
		new Text(theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", arg), 0, 0);

	const summaryLine = (theme: { fg(c: string, s: string): string }, text: string, items: string[], expanded: boolean) => {
		let s = theme.fg("success", "✓ ") + theme.fg("muted", text);
		const shown = expanded ? items : items.slice(0, 5);
		for (const i of shown) s += `\n  ${theme.fg("dim", i)}`;
		if (!expanded && items.length > shown.length) s += `\n  ${theme.fg("dim", `… ${items.length - shown.length} more`)}`;
		return new Text(s, 0, 0);
	};

	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web. Returns ranked results with title, URL, score and a snippet; optionally a short answer, several phrasings at once (merged, with domain consensus), and the full text of the top results.",
		promptSnippet: "web_search: search the web (current events, docs, facts outside the codebase)",
		promptGuidelines: [
			"Use web_search for anything that depends on current or external information; cite the URLs you rely on.",
			"Use web_fetch to read a specific page; use web_verify before stating a contested fact as true.",
		],
		parameters: SearchParams,
		namespace: NAMESPACE,
		annotations: READ_ONLY,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			return toResult(await runSearch(client(), params, signal));
		},
		renderCall(args, theme) {
			const q = args.queries?.length ? `${args.queries.length} queries: ${args.queries.join(" | ")}` : (args.query ?? "");
			return title(theme, "web_search", q);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { results?: Array<{ title: string; url: string }>; extracted?: string[] } | undefined;
			const items = (d?.results ?? []).map((r) => `${r.title} — ${r.url}`);
			const extra = d?.extracted?.length ? `, ${d.extracted.length} pages read` : "";
			return summaryLine(theme, `${items.length} results${extra}`, items, expanded);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Read web pages and return their content as markdown. With `intent`, returns the parts of each page most relevant to it. Failed URLs are listed with the reason.",
		promptSnippet: "web_fetch: read the content of web pages by URL",
		parameters: FetchParams,
		namespace: NAMESPACE,
		annotations: READ_ONLY,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			return toResult(await runFetch(client(), params, signal));
		},
		renderCall(args, theme) {
			return title(theme, "web_fetch", args.urls.length === 1 ? args.urls[0] : `${args.urls.length} URLs`);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { extracted?: string[]; failed?: Array<{ url: string; error: string }> } | undefined;
			const failed = d?.failed ?? [];
			const items = [...(d?.extracted ?? []), ...failed.map((f) => `✗ ${f.url} — ${f.error}`)];
			return summaryLine(theme, `${d?.extracted?.length ?? 0} pages read${failed.length ? `, ${failed.length} failed` : ""}`, items, expanded);
		},
	});

	pi.registerTool({
		name: "web_verify",
		label: "Web verify",
		description:
			"Check a claim against the web: searches for evidence and returns an evidence summary with sources. Pass `counter` to search the opposing statement too.",
		promptSnippet: "web_verify: check a factual claim (and optionally its counter-claim) against web sources",
		parameters: VerifyParams,
		namespace: NAMESPACE,
		annotations: READ_ONLY,
		executionMode: "parallel",
		async execute(_id, params, signal) {
			return toResult(await runVerify(client(), params, signal));
		},
		renderCall(args, theme) {
			return title(theme, "web_verify", args.counter ? `${args.claim} ⟷ ${args.counter}` : args.claim);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { sides?: Array<{ label: string; results: unknown[]; answer?: string }> } | undefined;
			const items = (d?.sides ?? []).map((s) => `${s.label}: ${s.results.length} sources${s.answer ? ` — ${s.answer.slice(0, 120)}` : ""}`);
			return summaryLine(theme, `${d?.sides?.length ?? 0} side(s) checked`, items, expanded);
		},
	});

	pi.registerTool({
		name: "web_watch",
		label: "Web watch",
		description:
			"Monitor a topic across sessions. The first call records a baseline; later calls with the same name return only sources not seen before.",
		promptSnippet: "web_watch: report new web sources on a topic since the last check",
		parameters: WatchParams,
		namespace: NAMESPACE,
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async execute(_id, params, signal) {
			return toResult(await runWatch(client(), params, { stateDir: watchDir, now: () => new Date() }, signal));
		},
		renderCall(args, theme) {
			return title(theme, "web_watch", args.name ? `${args.name}: ${args.query}` : args.query);
		},
		renderResult(result, { expanded }, theme) {
			const d = result.details as { baseline?: boolean; results?: Array<{ title: string; url: string }> } | undefined;
			const items = (d?.results ?? []).map((r) => `${r.title} — ${r.url}`);
			return summaryLine(theme, d?.baseline ? `baseline: ${items.length} sources` : `${items.length} new`, items, expanded);
		},
	});

	pi.registerCommand("web-key", {
		description: "Set the Tavily API key used by the web tools (checked before saving)",
		handler: async (args, ctx) => {
			const key = args.trim() || (ctx.hasUI ? ((await ctx.ui.input("Tavily API key", "tvly-...")) ?? "").trim() : "");
			if (!key) {
				ctx.ui.notify("Usage: /web-key tvly-...  (get a key at https://app.tavily.com)", "warning");
				return;
			}
			try {
				await createTavilyClient({ fetch: globalThis.fetch, apiKey: key }).search({ query: "tavily", max_results: 1 });
				saveTavilyKey(keyFile, key);
				ctx.ui.notify(`Tavily key verified and saved to ${keyFile}`, "info");
			} catch (err) {
				ctx.ui.notify(`Key not saved: ${(err as Error).message}`, "error");
			}
		},
	});
}
