#!/bin/sh
# Runs the whole suite in one node process so the summary and exit code cover every file.
# Requires Node >= 22.18 (built-in TypeScript type stripping; the tests import extensions/lib/*.ts).
cd "$(dirname "$0")/.." && exec node --test tests/*.test.mjs
