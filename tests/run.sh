#!/bin/sh
set -e
echo "Running pi-superpowers test suite..."
node --test tests/extension.test.mjs
node --test tests/agents.test.mjs
node --test tests/todo.test.mjs
node --test tests/integration.test.mjs
echo "All tests passed!"
