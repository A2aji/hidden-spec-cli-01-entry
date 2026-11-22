# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/A2aji/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/A2aji/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, in all four formats models use: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls — to the one specification in `SPEC.md`. It finds the lines an edit names even when the model drifted their whitespace or indentation (three matching tiers: exact, trailing-whitespace, full trim with re-indentation), handles CRLF files, files without a final line break, creates/deletes/moves files, and changes every file or none: a failed edit is reported and nothing is written. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Verified

- Practice set: **100/100, score 1000** (`node check.ts ../program/generator/practice.json` from the kit), on Node 22.21.0.
- 30 extra hand-built edge cases (parse errors, pure renames/moves, empty-O inserts at the end, `\ No newline at end of file`, `--strict`, `--check` with a move, V4A anchors/cursor/EOF chunks): 30/30.
- Deterministic; Node 22 standard library only, nothing installed.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / omitted to read from standard input. The working directory is the root of the tree. Exit 0 prints one line per changed path (`A`/`D`/`M`/`R old -> new`, byte order) plus `ok: <n> files`; exit 1 lists each failed edit plus `failed: <k> of <n> edits` and writes nothing; exit 2 is a usage, missing-patch, format or parse error.

---

<sub>Entered on [make.fun](https://make.fun/?ref=a2aji&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
