/**
 * What the web_search / web_fetch / web_verify / web_watch tools do, minus the
 * Pi wiring in extensions/web.ts. Each run* returns the model-facing markdown
 * and JSON-serialisable details for rendering.
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TavilyClient, TavilyResult } from "./tavily.ts";

export const MAX_QUERIES = 5;
const DEFAULT_SNIPPET_CHARS = 300;
const DEFAULT_PAGE_CHARS = 4000;

/** Bad tool arguments; reported to the model as a failed call. */
export class WebInputError extends Error {}

export type Depth = "basic" | "advanced";
export type Topic = "general" | "news" | "finance";
export type Since = "day" | "week" | "month" | "year";

export interface SearchOptions {
	topic?: Topic;
	since?: Since;
	depth?: Depth;
	max_results?: number;
	include_answer?: boolean;
	include_domains?: string[];
	exclude_domains?: string[];
	/** Snippet characters per result; 0 hides snippets. */
	max_chars?: number;
}

export interface SearchParams extends SearchOptions {
	query?: string;
	queries?: string[];
	/** Also extract the full text of the top N results. */
	extract_top?: number;
}

export interface FetchParams {
	urls: string[];
	intent?: string;
	depth?: Depth;
	/** Characters per page; 0 hides content. */
	max_chars?: number;
}

export interface VerifyParams extends Omit<SearchOptions, "include_answer"> {
	claim: string;
	counter?: string;
}

export interface WatchParams extends Omit<SearchOptions, "include_answer"> {
	query: string;
	name?: string;
}

export interface ResultSummary {
	title: string;
	url: string;
	score?: number;
	foundBy?: string[];
}

export interface WebToolOutput<D> {
	text: string;
	details: D;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clip(text: string | undefined, chars: number): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > chars ? `${flat.slice(0, chars)}…` : flat;
}

function clipBlock(text: string | undefined, chars: number): string {
	const t = String(text ?? "").trim();
	return t.length > chars ? `${t.slice(0, chars)}\n…[${t.length - chars} more chars]` : t;
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

const intIn = (v: number | undefined, min: number, max: number, dflt: number) =>
	v === undefined ? dflt : Math.min(max, Math.max(min, Math.trunc(v)));

function summary(r: TavilyResult & { foundBy?: string[] }): ResultSummary {
	return { title: r.title || r.url, url: r.url, score: r.score, ...(r.foundBy ? { foundBy: r.foundBy } : {}) };
}

function formatResults(
	results: Array<TavilyResult & { foundBy?: string[] }>,
	chars: number,
	extra: (r: TavilyResult & { foundBy?: string[] }) => string = () => "",
): string {
	if (results.length === 0) return "_No results._";
	return results
		.map((r, i) => {
			const score = typeof r.score === "number" ? ` — score ${r.score.toFixed(2)}` : "";
			const date = r.published_date ? ` — ${r.published_date}` : "";
			let line = `${i + 1}. [${r.title || r.url}](${r.url})${score}${date}${extra(r)}`;
			if (chars > 0 && r.content) line += `\n   ${clip(r.content, chars)}`;
			return line;
		})
		.join("\n");
}

function searchBody(query: string, o: SearchOptions, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		query,
		search_depth: o.depth ?? "basic",
		max_results: intIn(o.max_results, 1, 20, 5),
		topic: o.topic ?? "general",
		include_answer: Boolean(o.include_answer),
		...overrides,
	};
	if (o.since && body.time_range === undefined) body.time_range = o.since;
	if (o.include_domains?.length) body.include_domains = o.include_domains;
	if (o.exclude_domains?.length) body.exclude_domains = o.exclude_domains;
	return body;
}

function pagesSection(
	pages: Array<{ url: string; raw_content?: string }>,
	failed: Array<{ url: string; error: string }>,
	chars: number,
): string {
	const parts = pages.map((p) => `#### ${p.url}\n\n${chars > 0 ? clipBlock(p.raw_content, chars) : "_(content hidden: max_chars 0)_"}`);
	if (failed.length) parts.push(`#### Failed\n\n${failed.map((f) => `- ${f.url} — ${f.error}`).join("\n")}`);
	return parts.join("\n\n") || "_Nothing extracted._";
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

export interface SearchDetails {
	queries: string[];
	answer?: string;
	results: ResultSummary[];
	consensus?: Array<{ domain: string; count: number; avgScore: number }>;
	extracted?: string[];
	failed?: Array<{ url: string; error: string }>;
}

export async function runSearch(client: TavilyClient, p: SearchParams, signal?: AbortSignal): Promise<WebToolOutput<SearchDetails>> {
	const queries = [...(p.query !== undefined ? [p.query] : []), ...(p.queries ?? [])].map((q) => q.trim());
	if (queries.length === 0 || queries.some((q) => !q)) throw new WebInputError("Provide a non-empty `query` or `queries`.");
	if (queries.length > MAX_QUERIES) throw new WebInputError(`At most ${MAX_QUERIES} queries per call.`);

	const chars = intIn(p.max_chars, 0, 100_000, DEFAULT_SNIPPET_CHARS);
	const responses = await Promise.all(queries.map((q) => client.search(searchBody(q, p), signal)));

	// Merge by URL, keeping the best score and every query that found it.
	const byUrl = new Map<string, TavilyResult & { foundBy: string[] }>();
	responses.forEach((d, i) => {
		for (const r of d.results ?? []) {
			const prev = byUrl.get(r.url);
			if (!prev) byUrl.set(r.url, { ...r, foundBy: [queries[i]] });
			else {
				prev.foundBy.push(queries[i]);
				if ((r.score ?? 0) > (prev.score ?? 0)) Object.assign(prev, r, { foundBy: prev.foundBy });
			}
		}
	});
	const merged = [...byUrl.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	const multi = queries.length > 1;

	const answers = responses.map((d) => d.answer).filter((a): a is string => Boolean(a));
	const parts: string[] = [multi ? `## Web search: ${queries.length} queries — ${merged.length} unique results` : `## Web search: ${queries[0]}`];
	if (answers.length) parts.push(answers.map((a) => `**Answer:** ${a}`).join("\n\n"));
	parts.push(formatResults(merged, chars, multi ? (r) => ` — found by: ${r.foundBy!.join(", ")}` : undefined));

	const details: SearchDetails = { queries, results: merged.map(summary) };
	if (answers.length) details.answer = answers.join("\n\n");

	if (multi) {
		const domains = new Map<string, { hits: Set<number>; scores: number[] }>();
		responses.forEach((d, i) => {
			for (const r of d.results ?? []) {
				const e = domains.get(domainOf(r.url)) ?? { hits: new Set<number>(), scores: [] };
				e.hits.add(i);
				e.scores.push(r.score ?? 0);
				domains.set(domainOf(r.url), e);
			}
		});
		details.consensus = [...domains.entries()]
			.map(([domain, e]) => ({ domain, count: e.hits.size, avgScore: e.scores.reduce((a, b) => a + b, 0) / e.scores.length }))
			.sort((a, b) => b.count - a.count || b.avgScore - a.avgScore);
		parts.push(
			`### Domain consensus\n\n${details.consensus
				.map((c) => `- ${c.domain} — ${c.count}/${queries.length} queries (avg score ${c.avgScore.toFixed(2)})`)
				.join("\n")}`,
		);
	}

	const top = intIn(p.extract_top, 0, 5, 0);
	if (top > 0 && merged.length > 0) {
		const urls = merged.slice(0, top).map((r) => r.url);
		const ex = await client.extract({ urls, extract_depth: p.depth ?? "basic" }, signal);
		details.extracted = (ex.results ?? []).map((r) => r.url);
		details.failed = ex.failed_results ?? [];
		parts.push(`### Full text of the top ${urls.length}\n\n${pagesSection(ex.results ?? [], details.failed, DEFAULT_PAGE_CHARS)}`);
	}

	return { text: `${parts.join("\n\n")}\n`, details };
}

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

export interface FetchDetails {
	urls: string[];
	intent?: string;
	extracted: string[];
	failed: Array<{ url: string; error: string }>;
}

export async function runFetch(client: TavilyClient, p: FetchParams, signal?: AbortSignal): Promise<WebToolOutput<FetchDetails>> {
	const urls = (p.urls ?? []).map((u) => u.trim()).filter(Boolean);
	if (urls.length === 0) throw new WebInputError("Provide at least one URL in `urls`.");
	if (urls.length > 20) throw new WebInputError("At most 20 URLs per call.");

	const body: Record<string, unknown> = { urls, extract_depth: p.depth ?? "basic" };
	if (p.intent?.trim()) {
		body.query = p.intent.trim();
		body.chunks_per_source = 5;
	}
	const data = await client.extract(body, signal);
	const pages = data.results ?? [];
	const failed = data.failed_results ?? [];
	const chars = intIn(p.max_chars, 0, 1_000_000, DEFAULT_PAGE_CHARS);
	const intent = p.intent?.trim() ? ` (intent: ${p.intent.trim()})` : "";
	return {
		text: `## Web fetch${intent}\n\n${pagesSection(pages, failed, chars)}\n`,
		details: { urls, intent: p.intent?.trim() || undefined, extracted: pages.map((r) => r.url), failed },
	};
}

// ---------------------------------------------------------------------------
// web_verify
// ---------------------------------------------------------------------------

export interface VerifyDetails {
	sides: Array<{ label: "claim" | "counter"; query: string; answer?: string; results: ResultSummary[] }>;
}

export async function runVerify(client: TavilyClient, p: VerifyParams, signal?: AbortSignal): Promise<WebToolOutput<VerifyDetails>> {
	if (!p.claim?.trim()) throw new WebInputError("Provide the `claim` to verify.");
	const sides: Array<["claim" | "counter", string]> = [["claim", p.claim.trim()]];
	if (p.counter?.trim()) sides.push(["counter", p.counter.trim()]);
	const chars = intIn(p.max_chars, 0, 100_000, DEFAULT_SNIPPET_CHARS);

	const responses = await Promise.all(sides.map(([, q]) => client.search(searchBody(q, p, { include_answer: true }), signal)));
	const sections = sides.map(([label, q], i) => {
		const d = responses[i];
		const answer = d.answer ? `**Evidence summary:** ${d.answer}\n\n` : "";
		return `### ${label === "claim" ? "Claim" : "Counter"}: ${q}\n\n${answer}${formatResults(d.results ?? [], chars)}`;
	});
	return {
		text: `## Verify\n\n${sections.join("\n\n")}\n`,
		details: {
			sides: sides.map(([label, query], i) => ({
				label,
				query,
				answer: responses[i].answer ?? undefined,
				results: (responses[i].results ?? []).map(summary),
			})),
		},
	};
}

// ---------------------------------------------------------------------------
// web_watch
// ---------------------------------------------------------------------------

export interface WatchState {
	name: string;
	query: string;
	created: string;
	lastRun: string;
	seen: Record<string, string>;
}

export interface WatchDetails {
	name: string;
	baseline: boolean;
	previousRun?: string;
	results: ResultSummary[];
}

export function watchName(query: string, name?: string): string {
	const n = name?.trim() || query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "watch";
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) throw new WebInputError('`name` may contain only letters, digits, ".", "_" and "-".');
	return n;
}

export async function runWatch(
	client: TavilyClient,
	p: WatchParams,
	env: { stateDir: string; now: () => Date },
	signal?: AbortSignal,
): Promise<WebToolOutput<WatchDetails>> {
	if (!p.query?.trim()) throw new WebInputError("Provide the `query` to watch.");
	const name = watchName(p.query, p.name);
	const file = join(env.stateDir, `${name}.json`);
	let state: WatchState | null = null;
	try {
		state = JSON.parse(readFileSync(file, "utf8")) as WatchState;
	} catch {
		/* first run */
	}

	const data = await client.search(searchBody(p.query.trim(), { ...p, max_results: p.max_results ?? 10 }), signal);
	const results = data.results ?? [];
	const stamp = env.now().toISOString();
	const chars = intIn(p.max_chars, 0, 100_000, DEFAULT_SNIPPET_CHARS);
	mkdirSync(env.stateDir, { recursive: true });

	if (!state) {
		state = { name, query: p.query.trim(), created: stamp, lastRun: stamp, seen: Object.fromEntries(results.map((r) => [r.url, stamp])) };
		writeFileSync(file, JSON.stringify(state, null, 2));
		return {
			text: `## Watch "${name}": baseline — ${results.length} sources recorded\n\nLater calls with the same name report only sources not seen before.\n\n${formatResults(results, chars)}\n`,
			details: { name, baseline: true, results: results.map(summary) },
		};
	}

	const fresh = results.filter((r) => !(r.url in state!.seen));
	const previousRun = state.lastRun;
	for (const r of fresh) state.seen[r.url] = stamp;
	state.lastRun = stamp;
	writeFileSync(file, JSON.stringify(state, null, 2));
	const header = `## Watch "${name}": ${fresh.length} new source${fresh.length === 1 ? "" : "s"} since ${previousRun}`;
	return {
		text: fresh.length ? `${header}\n\n${formatResults(fresh, chars)}\n` : `${header}\n\nNo new sources.\n`,
		details: { name, baseline: false, previousRun, results: fresh.map(summary) },
	};
}
