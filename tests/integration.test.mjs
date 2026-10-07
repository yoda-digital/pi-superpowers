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
});

describe("skills", () => {
  it("ships the 14 Superpowers skills", () => {
    assert.deepEqual(shippedSkills, [
      "brainstorming",
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
});

// ---------------------------------------------------------------------------
// Docs must match code
// ---------------------------------------------------------------------------

describe("README", () => {
  it("lists exactly the shipped agents", () => {
    const listed = [...readme.matchAll(/^\| \*\*(\w+)\*\* \|/gm)].map((m) => m[1]).sort();
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
});

describe("references/pi-tools.md", () => {
  it("states the real default agent scope", () => {
    assert.match(piTools, new RegExp(`defaults to \`"${DEFAULT_AGENT_SCOPE}"\``));
  });

  it("names the real user agents directory", () => {
    assert.ok(piTools.includes("~/.pi/agent/agents/"));
    assert.ok(!piTools.includes("~/.pi/agents/"));
  });

  it(`documents the ${PROMPT_MODE_ENV} switch`, () => {
    assert.match(piTools, new RegExp(PROMPT_MODE_ENV));
  });

  it("says Pi has no worktree tools", () => {
    assert.match(piTools, /does not ship dedicated worktree tools/);
  });

  it("documents every todo action", () => {
    for (const a of ACTIONS) assert.ok(piTools.includes(`"${a}"`), a);
  });
});
