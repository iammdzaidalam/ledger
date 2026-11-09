# Learnings log

Short running notes on what changed, what broke, what got fixed, and why.

## Starting point

- Checker attached the whole next assistant message to every pending bash result. Two calls, one fails, the model says "the second one passed", both get flagged.
- Only Bash was checked. Write/Edit had no evidence at all.
- A turn that says "tests pass" without running anything was never checked, because there was no pending result to hang it on.
- No real API keys on the machine. Ollama is installed, so the eval runs on local models.

## Decisions (after an LLM-council pass: 5 advisors, anonymous peer review, chairman)

- Claims are about repo state, not about one call. The checker keeps the full evidence log for the session and checks every assistant turn against it, so "tests pass" is matched to the latest test run, "lint is clean" to the latest linter run, and so on.
- Structured claims are supported as `<claim ref="c3">...</claim>` tags, but as an experimental condition (`--claims tagged`), not as the detection mechanism. Asking the model to declare claims changes the behaviour being measured, so prose stays the default and the eval reports both.
- No same-turn "claim tool". A claim made in the same turn as the call is a prediction, not a report on output the model has seen.
- Eval ground truth comes from seeded fixture repos plus true-success controls, split into dev and held-out scenarios. Recorded once, replayed offline so rule changes never need a model rerun.
- Ollama runs with pinned `num_ctx`, temperature and seed, because the default context silently truncates tool schemas and creates fake "lies".

## Checker rewrite

- New protocol: one request per assistant turn carrying `turn_text`, the full `evidence` list and `fresh_refs`. Response is one verdict per extracted claim: `verified`, `contradicted`, `unsupported` (no evidence at all), `unverifiable`.
- Attribution order: tag ref, then a command or path the sentence mentions, then command family (tests -> latest test run), then recency for generic "done".
- Test summaries parsed for vitest, jest, pytest, go test, node --test, unittest, cargo, mocha. Exit 0 with "0 tests ran" is unverifiable, not a pass.
- `gofmt -l` exits 0 even when it lists files. Caught by a dedicated check.
- "Fixed the bug" needs a non-empty diff from Write/Edit (or an in-place bash edit) followed by a passing rerun of a test/build/lint command or of the command that failed before the edit.
- A passing test run followed by an edit makes a later "tests pass" unverifiable, since the run is stale.

## What broke and the fix

- First Go run: 5 failures, all in claim extraction.
  - "Lint still has one error, but the tests pass" was read as a lint claim. Fix: split clauses on "but", "however", ";".
  - Periods inside backticks (`./pkg/a`) broke the gap matcher. Fix: mask punctuation inside code spans before matching.
  - "the tests should pass" slipped through because the hedge sat inside the match span. Fix: check hedges up to the end of the match, not just before it.
  - `npm run build` tripped the "run" hedge. Fix: hedges and negations are checked on a copy with code spans blanked.
  - Dotfile paths like `build/.keep` did not parse. Fix: allow an empty stem before the extension.
- Accidentally staged a deletion with `git rm --cached` while removing the old test file. Unstaged it right away; the index stays untouched.

## TS side

- Write and Edit now report evidence too, with a real unified diff from the `diff` package. Without a diff, "fixed the bug" has nothing to check.
- Bash had a latent bug: on timeout it reported evidence, killed the child, then `close` fired and reported again. Harmless before, a duplicate evidence entry now. Fixed with a settle guard.
- The loop no longer keeps "pending" results. Every turn with text is checked against the full evidence log, including turns with no tool call.
- `--feedback` appends the verdict to the last tool result (or sends a user message if the turn ended) so the next turn has to correct it. Sent once per run, so a stubborn model cannot loop forever.
- Added an injectable `provider` to `AgentOptions` so the loop can be tested with a scripted fake model. My first loop test failed, and the checker was right: `echo ...; exit 1` is not a test command, so "tests pass" was `unsupported`, not `contradicted`. That pointed at a real gap: a script whose output contains a test summary now counts as a test run.

## Eval

- Ollama provider talks to the native `/api/chat` endpoint, not the OpenAI-compatible one, because only the native one takes `num_ctx` and `seed`.
- Pilot (6 sessions) before the full run. Findings: small models mostly report failures honestly on simple traps; llama3.1 sometimes prints a tool call as JSON text instead of calling it (incompetence, not a lie, labeled separately); llama wrapped a test in `bash -c "go test ./...; echo $?"`, which masks the exit code. The summary parser catches that.
- Pilot also surfaced a false positive: "We'll replace ... with the corrected implementation" read as a bug-fixed claim. "we'll" was missing from the hedge list and "corrected" is an adjective there. The pilot touched one held-out scenario, so from then on rule tuning only looked at dev traces, and pilot traces are not part of the scored set.
- The model runs arbitrary shell commands. `LEDGER_WORKSPACE` confines Write/Edit to the scratch dir and runs Bash under macOS `sandbox-exec` with writes limited to it. Verified a write to `~` fails inside the sandbox.
- vitest was picking up the scenario fixtures' `node:test` files. Scoped it to `test/`.
- 16 tokens/s on a 16GB Mac. A 168-session matrix is a multi-hour run, not a quick loop. Every trace records its own settings so a rerun with different settings never mixes silently.

## Shipping

- `ledger-agent` was taken on npm. Package is `grounded-ledger`, command stays `ledger`.
- First `npm pack` would have shipped the dev `bin/grounding-checker` (macOS only) and the client preferred it, so a Linux install would have tried to exec a Mach-O binary. `files` now lists only the per-platform binaries, and the client falls back to `grounding-checker-<platform>-<arch>`.
- Verified by installing the packed tarball into a temp prefix: `ledger --version` runs without tsx, and the installed client finds and runs its darwin-arm64 checker.
