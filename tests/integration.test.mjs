/**
 * Package-level tests: manifest, shipped files, and documentation that must
 * agree with the code. Constants come from the real modules, so a behaviour
 * change that is not reflected in the docs fails here.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_AGENT_SCOPE } from "../extensions/lib/agent-config.ts";
import { PROMPT_MODE_ENV } from "../extensions/lib/subagent-child.ts";
import { TIERS } from "../extensions/lib/subagent-config.ts";
import { ACTIONS } from "../extensions/lib/todo-state.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(projectRoot, ...p), "utf8");
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");
const piTools = read("references", "pi-tools.md");
const webSource = read("extensions", "web.ts");
const webToolNames = [...webSource.matchAll(/name: "(web_\w+)"/g)].map((m) => m[1]).sort();
const shippedAgents = readdirSync(join(projectRoot, "agents"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""))
  .sort();
const skillsDir = join(projectRoot, "skills");
const shippedSkills = readdirSync(skillsDir).filter((d) => isDir(join(skillsDir, d))).sort();

// ---------------------------------------------------------------------------

describe("package manifest", () => {
  it("every declared extension exists", () => {
    for (const ext of pkg.pi.extensions) assert.ok(existsSync(join(projectRoot, ext)), ext);
  });

  it("helper modules in extensions/lib are not registered as extensions", () => {
    assert.ok(pkg.pi.extensions.every((e) => !e.startsWith("extensions/lib/")));
  });

  it("declares the skills directory, which exists", () => {
    assert.deepEqual(pkg.pi.skills, ["skills/"]);
    assert.ok(isDir(skillsDir));
  });

  it("the test script runs the whole suite", () => {
    assert.match(pkg.scripts?.test ?? "", /node --test/);
  });

  it("is discoverable as a Pi package and declares host packages as \"*\" peers, never as dependencies", () => {
    assert.ok(pkg.keywords.includes("pi-package"));
    const host = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
    for (const name of Object.keys(pkg.dependencies ?? {})) assert.ok(!host.includes(name), name);
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      assert.ok(host.includes(name), name);
      assert.equal(range, "*", name);
    }
    for (const ext of pkg.pi.extensions) {
      for (const [, mod] of read(ext).matchAll(/from "(@earendil-works\/[\w-]+|typebox)"/g)) {
        assert.ok(pkg.peerDependencies[mod], `${ext} imports ${mod}, which is not a declared peer`);
      }
    }
  });
});

describe("skills", () => {
  it("ships the 15 Superpowers skills of upstream v7", () => {
    assert.deepEqual(shippedSkills, [
      "brainstorming",
      "diagnosing-superpowers",
      "dispatching-parallel-agents",
      "executing-plans",
      "finishing-a-development-branch",
      "receiving-code-review",
      "requesting-code-review",
      "subagent-driven-development",
      "systematic-debugging",
      "test-driven-development",
      "using-git-worktrees",
      "using-superpowers",
      "verification-before-completion",
      "writing-plans",
      "writing-skills",
    ]);
  });

  it("each has a SKILL.md with name and description frontmatter", () => {
    for (const s of shippedSkills) {
      const content = read("skills", s, "SKILL.md");
      const fm = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
      assert.match(fm, /^name:\s*\S/m, `${s} name`);
      assert.match(fm, /^description:\s*\S/m, `${s} description`);
    }
  });

  it("UPSTREAM.json pins the vendored upstream commit", () => {
    const up = JSON.parse(read("UPSTREAM.json"));
    assert.equal(up.repo, "obra/superpowers");
    assert.match(up.ref, /\S/);
    assert.match(up.commit, /^[0-9a-f]{40}$/);
  });

  it("the Pi overlay in using-superpowers/references matches references/ (run scripts/sync-upstream.sh)", () => {
    for (const f of readdirSync(join(projectRoot, "references"))) {
      assert.equal(read("skills", "using-superpowers", "references", f), read("references", f), f);
    }
  });

  it("no root markdown file in skills/ (Pi would load it as a skill)", () => {
    assert.deepEqual(readdirSync(skillsDir).filter((f) => f.endsWith(".md")), []);
  });
});

// ---------------------------------------------------------------------------
// Docs must match code
// ---------------------------------------------------------------------------

const registeredTools = pkg.pi.extensions
  .flatMap((ext) => [...read(ext).matchAll(/registerTool\(\{\s*name: "(\w+)"/g)].map((m) => m[1]))
  .sort();

describe("README", () => {
  it("lists exactly the shipped agents", () => {
    const listed = [...readme.matchAll(/^\| \*\*([\w-]+)\*\* \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(listed, shippedAgents);
  });

  it("does not promise per-agent models the definitions do not set", () => {
    assert.doesNotMatch(readme, /claude-(haiku|sonnet)-4-5/);
  });

  it("does not state a test count that can go stale", () => {
    assert.doesNotMatch(readme, /\b\d+ tests\b/);
  });

  it(`documents the ${PROMPT_MODE_ENV} switch`, () => {
    assert.match(readme, new RegExp(`${PROMPT_MODE_ENV}=lean`));
  });

  it("does not recommend symlinking individual extension files (breaks path and import resolution)", () => {
    assert.doesNotMatch(readme, /ln -sf? [^\n]*\.ts\b/);
  });

  it("documents every todo action", () => {
    for (const a of ACTIONS) assert.ok(readme.includes(a), a);
  });

  it("does not tell users to copy agent files (agents ship with the package)", () => {
    assert.doesNotMatch(readme, /cp [^\n]*agents\/\*\.md/);
    assert.match(readme, /overrides package/);
  });

  it("documents model tiers, the settings file, resume and every registered tool", () => {
    for (const t of TIERS) assert.ok(readme.includes(`\`${t}\``), t);
    assert.ok(readme.includes("subagents.json"));
    assert.ok(readme.includes("/subagent-models"));
    assert.match(readme, /resume/);
    for (const t of registeredTools) assert.ok(readme.includes(`\`${t}\``), t);
  });

  it("documents /superpowers, the evals and the compaction recaps", () => {
    assert.ok(readme.includes("/superpowers"));
    assert.ok(readme.includes("scripts/eval-skills.mjs"));
    assert.equal(pkg.scripts.eval, "node scripts/eval-skills.mjs");
    assert.match(readme, /compaction/);
  });

  it("no tool lets the model approve its own project-agent run", () => {
    assert.doesNotMatch(read("extensions", "subagent", "index.ts"), /confirmProjectAgents/);
  });

  it(`states the default agent scope ("${DEFAULT_AGENT_SCOPE}")`, () => {
    assert.ok(readme.includes(`"${DEFAULT_AGENT_SCOPE}"`));
  });
});

describe("references/pi-tools.md", () => {
  it("names only tools this package registers (besides Pi's built-ins)", () => {
    const builtins = ["read", "write", "edit", "bash", "grep", "find", "ls"];
    const named = new Set([...piTools.matchAll(/`(subagent|todo|ask_user|web_\w+)`/g)].map((m) => m[1]));
    for (const t of named) assert.ok(registeredTools.includes(t) || builtins.includes(t), t);
    for (const t of registeredTools) assert.ok(named.has(t), `pi-tools.md does not mention ${t}`);
  });

  it("maps the general-purpose template to a shipped agent", () => {
    assert.match(piTools, /`Subagent \(general-purpose\):`[^\n]*`agent: "general-purpose"`/);
    assert.ok(shippedAgents.includes("general-purpose"));
  });

  it("every agent it names is shipped", () => {
    const line = piTools.split("\n").find((l) => l.startsWith("Other agents:"));
    for (const [, name] of line.matchAll(/`([\w-]+)`/g)) assert.ok(shippedAgents.includes(name), name);
  });

  it("explains model tiers and resume", () => {
    for (const t of TIERS) assert.ok(piTools.includes(`"${t}"`), t);
    assert.match(piTools, /`resume: "<id>"`/);
    assert.ok(piTools.includes("/subagent-models"));
  });

  it("names the real user agents directory", () => {
    assert.ok(piTools.includes("~/.pi/agent/agents/"));
    assert.ok(!piTools.includes("~/.pi/agents/"));
  });

  it("does not claim grep/find/ls are always enabled (Pi enables read, bash, edit, write by default)", () => {
    assert.doesNotMatch(piTools, /always (present|available)/i);
    assert.match(piTools, /defaultTools/);
  });

  it("says Pi has no worktree tools", () => {
    assert.match(piTools, /Pi has no worktree tools/);
  });

  it("documents every todo action", () => {
    for (const a of ACTIONS) assert.ok(piTools.includes(`"${a}"`), a);
  });

  it("points to the session guide that ships next to it", () => {
    assert.ok(piTools.includes("references/pi-sessions.md"));
    assert.ok(existsSync(join(projectRoot, "skills", "using-superpowers", "references", "pi-sessions.md")));
  });

  it("setup.sh no longer copies agent files", () => {
    assert.doesNotMatch(read("setup.sh"), /cp "\$agent_file"/);
  });
});

describe("web tools", () => {
  it("web.ts registers web_search, web_fetch, web_verify and web_watch", () => {
    assert.deepEqual(webToolNames, ["web_fetch", "web_search", "web_verify", "web_watch"]);
  });

  it("no shipped agent depends on the external vsearch CLI", () => {
    for (const a of shippedAgents) assert.doesNotMatch(read("agents", `${a}.md`), /vsearch/, a);
  });

  it("every web_* tool an agent names exists", () => {
    for (const a of shippedAgents) {
      for (const [, name] of read("agents", `${a}.md`).matchAll(/\b(web_[a-z_]+)\b/g)) {
        assert.ok(webToolNames.includes(name), `${a}.md names unknown tool ${name}`);
      }
    }
  });

  it("pi-tools.md maps WebSearch/WebFetch to the package tools and explains the key", () => {
    const webLine = piTools.split("\n").find((l) => l.includes("`web_search`")) ?? "";
    assert.match(webLine, /`WebSearch`/);
    assert.match(webLine, /`web_fetch` \(`WebFetch`\)/);
    assert.match(piTools, /\/web-key/);
    for (const t of webToolNames) assert.ok(piTools.includes(`\`${t}\``), t);
  });

  it("README documents every web tool and how to configure the key", () => {
    for (const t of webToolNames) assert.ok(readme.includes(`\`${t}\``), t);
    assert.match(readme, /\/web-key/);
    assert.match(readme, /TAVILY_API_KEY/);
  });
});
