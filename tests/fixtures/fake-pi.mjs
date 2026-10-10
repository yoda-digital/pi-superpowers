#!/usr/bin/env node
// Stands in for `pi --mode json -p ...` in the subagent runner tests.
// Behaviour is chosen with FAKE_PI_MODE; the answer echoes what the child
// received (argv, stdin, the child marker) so tests can assert on it.

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const mode = process.env.FAKE_PI_MODE ?? "ok";
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const assistant = (content, extra = {}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content,
    provider: "fake",
    model: "fake-model",
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.001 } },
    ...extra,
  },
});

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  emit({ type: "session", version: 3, id: flag("--session-id") ?? "none", cwd: process.cwd() });
  emit({ type: "agent_start" });
  const report = JSON.stringify({ stdinLength: stdin.length, stdinHead: stdin.slice(0, 80), args, child: process.env.PI_SUPERPOWERS_CHILD ?? null, cwd: process.cwd() });

  switch (mode) {
    case "ok":
      emit(assistant([{ type: "toolCall", name: "read", arguments: { path: "/x" } }]));
      emit({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "file body" }] } });
      emit(assistant([{ type: "text", text: report }]));
      break;
    case "multi-text":
      emit(assistant([{ type: "text", text: "part one" }, { type: "text", text: "part two" }]));
      break;
    case "no-answer":
      emit(assistant([{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]));
      emit({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "tool says hi" }] } });
      emit(assistant([]));
      break;
    case "model-error":
      emit(assistant([], { stopReason: "error", errorMessage: "provider exploded" }));
      break;
    case "unicode-sep":
      // U+2028/U+2029 are legal inside JSON strings and must not split records.
      emit(assistant([{ type: "text", text: "line sep end" }]));
      break;
    case "split-writes": {
      // One record delivered in two chunks, with a multi-byte character cut in half.
      const line = Buffer.from(`${JSON.stringify(assistant([{ type: "text", text: "héllo wörld" }]))}\n`);
      process.stdout.write(line.subarray(0, 40));
      setTimeout(() => process.stdout.write(line.subarray(40)), 50);
      return;
    }
    case "exit-code":
      process.stderr.write("boom on stderr\n");
      process.exit(3);
      return;
    case "hang":
      setInterval(() => {}, 1000);
      return;
    case "ignore-term":
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      return;
  }
  emit({ type: "agent_settled", aborted: false });
});
