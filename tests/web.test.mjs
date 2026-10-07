/**
 * Tests for the web tools' logic (extensions/lib/web/*.ts). Tavily is replaced
 * by a fake fetch that records requests; everything else is the real code that
 * extensions/web.ts calls.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TavilyError,
  WebConfigError,
  createTavilyClient,
  resolveTavilyKey,
  saveTavilyKey,
  tavilyKeyFile,
} from "../extensions/lib/web/tavily.ts";
import { runFetch, runSearch, runVerify, runWatch, WebInputError } from "../extensions/lib/web/tools.ts";

const KEY = "tvly-test";

const result = (n, over = {}) => ({
  title: `Title ${n}`,
  url: `https://site${n}.example/page${n}`,
  content: `Content ${n} `.repeat(60),
  score: 0.9 - n / 100,
  ...over,
});

function fakeTavily(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const endpoint = new URL(url).pathname.slice(1);
    const body = JSON.parse(init.body);
    calls.push({ endpoint, body, headers: init.headers });
    const handler = routes[endpoint];
    if (!handler) throw new Error(`unexpected endpoint ${endpoint}`);
    const out = await handler(body, calls.filter((c) => c.endpoint === endpoint).length - 1);
    const status = out?.__status ?? 200;
    const payload = out?.__status ? out.body : out;
    return { ok: status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  return { client: createTavilyClient({ fetch, apiKey: KEY }), calls };
}

const searchRoute = (results = [result(1), result(2)], extra = {}) => ({
  search: (body) => ({ query: body.query, results, ...extra }),
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sp-web-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("Tavily key", () => {
  it("prefers TAVILY_API_KEY", () => {
    assert.equal(resolveTavilyKey({ TAVILY_API_KEY: " tvly-env " }, join(dir, "none.env")), "tvly-env");
  });

  it("falls back to the key file", () => {
    const file = tavilyKeyFile(dir);
    mkdirSync(join(dir, "superpowers"), { recursive: true });
    writeFileSync(file, "# c\nTAVILY_API_KEY='tvly-file'\n");
    assert.equal(resolveTavilyKey({}, file), "tvly-file");
  });

  it("explains how to configure it when missing", () => {
    assert.throws(() => resolveTavilyKey({}, join(dir, "none.env")), (e) =>
      e instanceof WebConfigError && /\/web-key/.test(e.message) && /TAVILY_API_KEY/.test(e.message));
  });

  it("saveTavilyKey writes a private file the resolver reads back", () => {
    const file = tavilyKeyFile(dir);
    saveTavilyKey(file, "tvly-saved");
    assert.equal(resolveTavilyKey({}, file), "tvly-saved");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "superpowers")).mode & 0o777, 0o700);
  });

  it("rejects keys that are not Tavily keys", () => {
    assert.throws(() => saveTavilyKey(tavilyKeyFile(dir), "sk-something"), WebConfigError);
  });
});

describe("Tavily client", () => {
  it("authenticates with a Bearer token", async () => {
    const { client, calls } = fakeTavily(searchRoute());
    await client.search({ query: "q" });
    assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  });

  it("turns HTTP errors into TavilyError with status and message", async () => {
    const { client } = fakeTavily({ search: () => ({ __status: 401, body: { detail: { error: "Unauthorized: missing or invalid API key." } } }) });
    await assert.rejects(client.search({ query: "q" }), (e) => e instanceof TavilyError && e.status === 401 && /invalid API key/.test(e.message));
  });
});

describe("web_search", () => {
  it("maps defaults", async () => {
    const { client, calls } = fakeTavily(searchRoute());
    await runSearch(client, { query: "rust async" });
    assert.deepEqual(calls[0].body, { query: "rust async", search_depth: "basic", max_results: 5, topic: "general", include_answer: false });
  });

  it("maps every option", async () => {
    const { client, calls } = fakeTavily(searchRoute());
    await runSearch(client, {
      query: "q", depth: "advanced", max_results: 10, include_answer: true, topic: "news", since: "week",
      include_domains: ["a.com"], exclude_domains: ["b.com"],
    });
    assert.deepEqual(calls[0].body, {
      query: "q", search_depth: "advanced", max_results: 10, topic: "news", include_answer: true,
      time_range: "week", include_domains: ["a.com"], exclude_domains: ["b.com"],
    });
  });

  it("formats title, url, score and a snippet capped by max_chars (default 300)", async () => {
    const { client } = fakeTavily(searchRoute(undefined, { answer: "Forty-two." }));
    const { text, details } = await runSearch(client, { query: "q", include_answer: true });
    assert.match(text, /\*\*Answer:\*\* Forty-two\./);
    assert.match(text, /\[Title 1\]\(https:\/\/site1\.example\/page1\) — score 0\.89/);
    const snippet = text.split("\n").find((l) => l.includes("Content 1"));
    assert.ok(snippet.trim().length <= 301);
    assert.equal(details.results.length, 2);
    assert.equal(details.results[0].url, "https://site1.example/page1");
  });

  it("max_chars 0 hides snippets", async () => {
    const { client } = fakeTavily(searchRoute());
    const { text } = await runSearch(client, { query: "q", max_chars: 0 });
    assert.doesNotMatch(text, /Content 1/);
    assert.ok(!text.split("\n").some((l) => l.startsWith("   ")), "no snippet lines at all");
  });

  it("several queries run in parallel, merge by url and show domain consensus", async () => {
    const shared = result(5, { url: "https://consensus.example/x" });
    const { client, calls } = fakeTavily({
      search: (body) => ({ results: body.query === "q1" ? [result(1), shared] : [result(2), shared] }),
    });
    const { text, details } = await runSearch(client, { queries: ["q1", "q2"] });
    assert.deepEqual(calls.map((c) => c.body.query).sort(), ["q1", "q2"]);
    assert.equal(text.split("https://consensus.example/x").length - 1, 1, "merged url listed once");
    assert.match(text, /found by: q1, q2/);
    assert.equal(details.results.length, 3);
    const consensus = text.slice(text.indexOf("Domain consensus"));
    assert.ok(consensus.indexOf("consensus.example — 2/2") < consensus.indexOf("site1.example"), text);
  });

  it("extract_top also extracts the top results' full text", async () => {
    const { client, calls } = fakeTavily({
      ...searchRoute([result(1), result(2), result(3)]),
      extract: (body) => ({ results: body.urls.map((u) => ({ url: u, raw_content: `FULL ${u}` })), failed_results: [] }),
    });
    const { text, details } = await runSearch(client, { query: "q", extract_top: 2, depth: "advanced" });
    const ex = calls.find((c) => c.endpoint === "extract").body;
    assert.deepEqual(ex.urls, ["https://site1.example/page1", "https://site2.example/page2"]);
    assert.equal(ex.extract_depth, "advanced");
    assert.match(text, /FULL https:\/\/site1\.example\/page1/);
    assert.equal(details.extracted.length, 2);
  });

  it("rejects missing or too many queries", async () => {
    const { client, calls } = fakeTavily(searchRoute());
    await assert.rejects(runSearch(client, {}), WebInputError);
    await assert.rejects(runSearch(client, { queries: ["a", "b", "c", "d", "e", "f"] }), WebInputError);
    await assert.rejects(runSearch(client, { query: "   " }), WebInputError);
    assert.equal(calls.length, 0);
  });
});

describe("web_fetch", () => {
  it("passes urls and intent (Tavily rerank query), caps pages, lists failures", async () => {
    const long = "x".repeat(10_000);
    const { client, calls } = fakeTavily({
      extract: () => ({
        results: [{ url: "https://a.example", raw_content: `API docs here ${long}` }],
        failed_results: [{ url: "https://b.example", error: "timeout" }],
      }),
    });
    const { text, details } = await runFetch(client, { urls: ["https://a.example", "https://b.example"], intent: "API docs" });
    assert.deepEqual(calls[0].body.urls, ["https://a.example", "https://b.example"]);
    assert.equal(calls[0].body.query, "API docs");
    assert.match(text, /API docs here/);
    assert.ok(text.length < 6000, "page capped at max_chars (default 4000)");
    assert.match(text, /https:\/\/b\.example — timeout/);
    assert.deepEqual(details.failed, [{ url: "https://b.example", error: "timeout" }]);
  });

  it("requires urls", async () => {
    const { client } = fakeTavily({});
    await assert.rejects(runFetch(client, { urls: [] }), WebInputError);
  });
});

describe("web_verify", () => {
  it("searches each side with an evidence summary", async () => {
    const { client, calls } = fakeTavily({
      search: (body) => ({ results: [result(body.query === "claim A" ? 1 : 2)], answer: `about ${body.query}` }),
    });
    const { text } = await runVerify(client, { claim: "claim A", counter: "counter B" });
    assert.deepEqual(calls.map((c) => c.body.query), ["claim A", "counter B"]);
    assert.ok(calls.every((c) => c.body.include_answer === true));
    assert.match(text, /Claim: claim A[\s\S]*about claim A[\s\S]*Counter: counter B[\s\S]*about counter B/);
  });
});

describe("web_watch", () => {
  const now = (iso) => () => new Date(iso);

  it("records a baseline, then reports only unseen sources", async () => {
    const stateDir = join(dir, "watch");
    let t = fakeTavily(searchRoute([result(1), result(2)]));
    const first = await runWatch(t.client, { query: "topic", name: "w1" }, { stateDir, now: now("2026-01-01T00:00:00Z") });
    assert.match(first.text, /baseline — 2 sources/);
    assert.ok(existsSync(join(stateDir, "w1.json")));

    t = fakeTavily(searchRoute([result(2), result(3)]));
    const second = await runWatch(t.client, { query: "topic", name: "w1" }, { stateDir, now: now("2026-01-02T00:00:00Z") });
    assert.match(second.text, /1 new source since 2026-01-01/);
    assert.match(second.text, /site3\.example/);
    assert.doesNotMatch(second.text, /site2\.example/);

    t = fakeTavily(searchRoute([result(1), result(3)]));
    const third = await runWatch(t.client, { query: "topic", name: "w1" }, { stateDir, now: now("2026-01-03T00:00:00Z") });
    assert.match(third.text, /No new sources/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(stateDir, "w1.json"), "utf8")).seen).sort(), [
      "https://site1.example/page1", "https://site2.example/page2", "https://site3.example/page3",
    ]);
  });

  it("derives a safe name from the query and rejects unsafe ones", async () => {
    const stateDir = join(dir, "watch");
    const t = fakeTavily(searchRoute());
    await runWatch(t.client, { query: "AI Act / news!" }, { stateDir, now: () => new Date() });
    assert.ok(existsSync(join(stateDir, "ai-act-news.json")));
    await assert.rejects(runWatch(t.client, { query: "x", name: "../evil" }, { stateDir, now: () => new Date() }), WebInputError);
  });
});
