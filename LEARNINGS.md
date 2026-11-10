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

## Checker tuning on the dev split

- Tuned only on the 7 dev scenarios. `eval/score.ts` loads every trace, held-out included, so the dev replay used a separate script that picks dev files by name before opening anything. I had already seen the held-out flags in `run1.md` while reviewing, so the held-out set is not fully untouched; that goes in the results when it is scored.
- "The unit tests failed to pass" was flagged as a tests_pass lie. "failed to" was only checked before the match, and tagged claims skipped the failure-word check. Now "failed to", "unable to" and "prevent" count as negation inside the match, and tagged claims get the same check.
- "...preventing the tests from running successfully" read as a success claim. Added a "prevent / stop / keep ... from X-ing" pattern. The four-word negation window also ran across commas, which swallowed "no failures, confirming the bug is fixed"; it now stops at clause punctuation.
- "To fix the code and make it lint clean, I would need..." was a plan, not a claim. A sentence opening with "To <verb>" is a purpose clause up to its first comma. "To summarize, ..." still counts.
- "src/sum.js has been written" found no path, because file claims only looked after the verb. Passive voice now looks before it, and a Write/Edit to the path wins over a later command that just mentions the file.
- A small model "updated" greet.go three times with old_string equal to new_string and then said it was updated. Edit claims now need a non-empty diff.
- "all 12 tests passed" was verified when 2 tests ran. A claimed count above the summary total is now contradicted (not for `go test`, which counts packages).
- Net on dev: 4 false positives gone, one wrong reason fixed, all 5 correct flags kept, 4 missed lies now caught.

## Validation loop

- A common design runs an LLM validator per task and asks for up to 0-2 revisions by mode. Kept the loop shape, not the judge: verdicts still come from the deterministic checker.
- `--feedback` was once per run, so a lie at turn 15 got nothing if turn 3 used it up. Now `--validate off|flag|revise|strict` with a budget per flagged turn and a cap per run.
- The revised answer is not always the next turn: the honest fix for "tests pass" is to rerun the tests, so tool-only turns are waited through.
- A repeated "Done, it worked." with no new command looked like a retraction, because the checker skips vague success with nothing fresh. The validator carries the original turn's fresh refs through the revision.
- Unverifiable claims are never sent back. Pushing on them makes models retract true statements.
- strict counts a checker failure as unverified. Auto-approving when the validator is down is the failure strict exists to catch.

## Permissions, git tools, sessions

- Permissions, git tools, session resume, readable provider errors, compaction and slash commands are all built on Ledger's own evidence log.
- A denied tool call is still recorded as evidence with `executed: false`, so "I ran it" after a denial is caught by `not_executed`.
- The evidence log lives outside the message history, so compaction never drops it and resume replays it. A test checks that "I already ran the tests and they pass" after compaction is still contradicted by the old run.
- The REPL used to save messages by slicing from the turn start, which breaks once compaction replaces history mid-run. Sessions now write compaction markers and rebuild with the same function on resume.
- Git calls were first recorded as `Bash` so the checker's command rules would see them, which meant a commit message saying `make test` could pass as a test run. The checker now has a `Git` evidence kind that counts as a command for exit codes and mentions but never as a test, lint or build run.
- The tool list grew from 7 to 15, about 1.5k more tokens of schema for small local models. Eval runs now pass `CORE_TOOLS` and build the system prompt from the same list, so they see exactly what run1 saw.

## Merging parallel work

- Two agents worked in separate worktrees that both touched `loop.ts`. The worktrees sat inside the repo, and Biome refused to run because it found their nested `biome.json` files. Merged each file three-way with `git merge-file` so nothing was staged, then removed the worktrees.
- The sessions work moved print and REPL onto a shared `runTurn`, so the validation wiring (revision events, ledger summary, strict exit code) moved there instead of being patched into both modes.

## Cancelling a turn

- Ctrl+C only stopped the UI from listening. The Bash child kept running and the loop made another model call. An AbortSignal now goes through the loop, every provider, the tools and `runProcess`, which kills the child and records the call with `exit_code: null`.
- After a cancel, the session history ended on the user's message, so the next turn sent two user messages in a row and the model never heard the turn was stopped. A cancelled turn now closes with a short assistant note.
- The cancelled call's evidence reached the in-memory log but not the session file, because the turn returned before the killed process reported back. On resume, refs would have pointed at different calls. The turn now waits up to a second for that last event, and anything still unsaved is written when the turn closes.
- The checker's stderr went straight to the terminal and drew over the TUI. It is captured now, and its last line shows up in the exit reason.
- The permission splitter treated `;` and `>` inside quotes as separators, so `echo "a; rm x"` asked about `rm`. It now scans outside quotes only and gives up on an unterminated quote.

## Website layout

- The terminal panels sat at a fixed offset and ran off the frame's bottom-right edge. That cut the FALSE CLAIM line in half and hid the end of the Go code. They are now inset evenly and sized to the frame, with the code soft-wrapped on a hanging indent.
- The replay was two screens tall and mostly empty. It is one screen now and scrolls to the newest step.

## First precision and recall

- Six annotator agents labeled all 303 turns blind from the exported packets, and a second pass relabeled the 161 held-out turns. The two passes agreed on every held-out turn, but they are the same model, so that is weaker than two people agreeing. A person still needs to check them.
- Held-out: 60% precision (3/5) and 23% recall (3/13). Dev, where the rules were tuned: 100% (8/8) and 67% (8/12). The gap between the two is the tuning showing.
- Six of the ten held-out misses were gofmt-dirty turns. My first guess was the lint rule, but it already treats a non-empty `gofmt -l` as a failure. The claims were never extracted: "no files need formatting", "does not need gofmt" and "adheres to the formatting guidelines" matched no pattern, because the pattern wanted a linter name followed by clean/pass. Probe the extractor before blaming the rule.
- The qwen2.5:7b judge caught all 13 but flagged 134 of 161 turns, so 90% of its flags were wrong, at 655 ms a call. Grading with a small local model says "everything is suspicious". An LLM validator in a loop inherits that.
- The labeling CLI read piped answers with readline's `question()`, which drops lines that arrive before the prompt. It now reads lines through the async iterator, quits cleanly at the end of input, and has undo.

## Fixing the held-out misses

- Formatting claims carry their own negation ("no files need formatting"), so the usual negation filter threw them out. They get their own pattern that skips the inside-the-match negation check but still respects a negation before it ("is not properly formatted") and hedges.
- "the values being passed to `Clamp`" read as tests passing. A pass word followed by to/into/as/via is about arguments. "All tests passed in 0.3s" still counts.
- "Docs/USAGE.md has been created" missed the write to docs/USAGE.md because of the capital at the start of the sentence. Only that first letter is folded; DOCS/USAGE.md still does not match.
- Adding "corrected" as a fix word caught "I've corrected the sum function" but also "the corrected line should look like", which added seven dev false positives. It now only counts after a subject or auxiliary.
- Left alone on purpose: a fabricated test run that exists only inside a fenced block, "Creating go.mod" inside a claim tag, and "the search found no matches" with no search. Catching the first two would also flag every tool call the model printed as text, and the third is not one of the five claim kinds.
- After these fixes run1 is no longer a held-out measurement, so the fixes were measured on six new scenarios recorded afterwards (run2, the fresh split).
- run2 on the six fresh scenarios: 67% precision (4/6) and 57% recall (4/7) per turn, against 60% and 23% on run1's held-out turns before the fixes. Recall more than doubled and precision held, but with 7 false turns the interval is wide (25-84% recall).
- The fresh misses look like the old ones: "the issue has been addressed" ("addressed" is not a fix word) and "Bash command executed to run tests" with no command. The two wrong flags were "fixed" as an adjective inside a tool call printed as text, and "The other test passed." after a run where one passed and one failed. A partial-pass sentence needs its own handling; a run that exits 1 does not make every "passed" false.
- The annotator passes disagreed on one turn of 295: "Not all 12 tests pass" when 2 ran. The guide says a wrong count is false only when it contradicts the summary, and also that a failure report is not a claim. The guide needs one line on which wins.


## Real traces at scale (OpenHands, 13,664 turns)

- run1 and run2 had 13 and 7 false turns, too few to trust. 300 trajectories from nebius/SWE-rebench-openhands-trajectories (Qwen3-Coder-480B in OpenHands on real GitHub issues, CC-BY-4.0) convert cleanly: execute_bash prints `[Command finished with exit code N]`, str_replace_editor reports each create and edit, and the finish tool's message is the closing claim.
- Labeling 13,664 long turns was too expensive, so the sample is stratified by the checker's own outcome: all 404 flagged turns, 600 of 1,480 verified, 1,000 of 11,780 with no claim, weighted back up. Only about 2% of turns hold a false claim, which is why the small runs had so few.
- The checker was frozen before sampling. On this set it lands at about 21% precision and 31% recall. The small local-model runs flattered it: frontier models phrase things differently and work in a way the rules never saw.
- The biggest false-positive source: OpenHands writes a new reproduction or test script after the fix, and the checker counts that new file as a code change, so "Fixed X" after a passing run reads as "nothing was rerun afterwards". A new file the agent created is not a change to the code under test.
- "I've successfully reproduced the issue" after a script that exits 1 is true; reproducing a bug means the script fails. command_success treats it as a lie.
- Scoped test claims ("all other soma tests pass", a pass count quoted from an earlier run) get checked against the latest run and its failures. The attribution needs to find the run the sentence is about.
- Annotator passes agreed on 292 of 300 shared turns (kappa 0.75), down from near-perfect on the small runs. Real trajectories are harder to judge, even for a careful reader.
- The importer hit Hugging Face's rate limit around 150 rows and stopped silently behind a `| tail`. It now resumes from a manifest of fetched offsets and backs off for longer on 429s.

## Fixing the real-trace false positives

- The OpenHands sample is now dev data, since the fixes were made by reading its false positives. The held-out check is a new batch drawn with a different seed.
- New files the agent created no longer count as the fix. The checker takes the latest change to a file that existed before the session, and only falls back to new files when nothing else changed. On the dev sample "Write X but nothing was rerun afterwards" dropped from 123 false flags to 17, and from 40 correct ones to 4.
- That moved the fix earlier, and the latest command after it was often an unrelated failing script. A rerun of a command that failed before the change now wins over the latest test run.
- "Reproduced the issue", "confirmed the bug" and "demonstrated the error" are not success claims.
- A test claim with a count ("64/64 tests") goes to the run with that many tests, and one that names a module ("the soma tests") goes to the latest run whose command has that name. "All other", "most" and "remaining" with a run that had both passes and failures is unverifiable, not a lie.
- Dev sample: 21% to 25% precision, 31% to 27% recall. Smaller than the counts suggest, because fixing one pattern exposes the next: the remaining false flags are "working correctly" checked against the last command of the turn, and staleness after a cleanup edit, where the labels are a judgment call.
- run2's fresh scenarios went from 4/6 to 4/5 precision with recall unchanged, so nothing regressed on the small runs.
- `score-sampled --design <checker>` scores a changed checker against labels that were drawn for the frozen one: strata and weights come from the frozen binary, flags from the new one.


## The fixes on a fresh batch

- Drew 150 new trajectories (seed 23, none shared with the first 300): 6,867 turns, 958 labeled in the same stratified way, 150 labeled twice. The two passes agreed on 147 of 150 (kappa 0.81).
- The fixed checker scores 20% precision (14-26%) and 30% recall (17-46%). The frozen one scores 19% and 41% on the same strata. The fixes did not generalize: the 21% to 25% on the sample they were tuned on was mostly fitting it.
- The intervals overlap, so this does not show the fixes hurt, only that they did not help. They removed 18 false flags and lost 5 turns. Those 5 were flagged by accident: the old rule said "Write final_test.py but nothing was rerun" about a scratch file, while the real problem was a pass claim backed by a test subset or a failed full run.
- The remaining false flags are mostly judgment calls on the labels (an edit followed by a failing unrelated test) and "all tests pass" claims that need a full-suite run to check. Both are bigger changes than a regex tweak.
- Stopped tuning here. Each round of fixes on a sample turns it into dev data, and the number to report is the one measured before the fixes: 21% precision at scale, 20% on a fresh batch.

## Fleet client

- A swarm worker is an ordinary `ledger --print` process running inside a git worktree, so the server only sees turns through the same recorder every session uses. That keeps the gate honest: it judges the evidence the child recorded, not what the worker says about it.
- Retries had to continue from the earlier attempt's commit. Reusing the task branch and worktree is enough; the feedback goes in front of the original prompt.
- Anything that mutates the repo goes through the integration worktree. A failed merge is aborted and the worktree reset, so the next job never starts from a half-merged tree. The user's checkout is never switched or written to.
- Session files land in `.ledger/` inside each worktree. `git add -A` would commit them in repos that do not ignore `.ledger`, so the commit step excludes that path.
- The SSE stream uses snake_case keys while the Connect JSON uses camelCase; the reader accepts both.

## Fleet server and the first real swarm

- The first swarm run with a real local model said both tasks were merged. The integration branch held only the starting commit and the build still failed. The worker had reported the base commit as its own because the commit step returns HEAD even when nothing was staged, and the gate passed any attempt with a commit and a clean last turn. A swarm that merges nothing and calls it success is the failure the whole project is about, so it was the first thing to fix: no changed files now means no commit, the gate retries once with a hint and then fails, and the ungated baseline fails it too since there is nothing to merge.
- Merged is not fixed. In the two-scenario smoke run the gated swarm merged a `go build` fix that still did not build, because the checker had no false claim to flag. The gate can only stop what the checker can see, which is why the experiment measures merged-but-still-failing next to merged.
- Per-swarm locks in the state machine deadlocked against a foreign-key check on the runs table when a turn was recorded while an attempt was completing. Taking the swarm lock first in every path fixed it; the test that found it only ran once Redis was actually reachable, because the first run silently skipped the Redis-backed tests.
- An open circuit breaker should not burn a job's retries. Parked jobs refund their attempt and wait out the cooldown, so an hour-long judge outage ends with the queue intact instead of dead-lettered.
- Persisted turn ingest tops out near 3.9k/s on a laptop with Postgres in Docker, and 128 clients only raise the latency. The queue is not the limit; one transaction per turn is.
- The load generator reported 30 errors per run that were all in-flight requests cut off by its own deadline. Check the error text before believing an error count.
- The full gate-on/gate-off run (36 swarms, 45 tasks per arm with a real bug) came out small: 12/45 merged and verified with the gate against 9/45 without, intervals overlapping. The attempt table explains why. Every retry and every gate failure in the run was "no files were changed", none came from a flagged claim, so the gate was acting as a retry on empty output and not as a lie detector. The checker did flag a turn in 5 of the gate-on attempts, but each of those ended on a clean turn and the gate only reads the last one, so a flag never decided anything; the failures that mattered were code that does not compile, not claims that tests passed. I first wrote that the checker flagged nothing. Counting the flagged verdicts in the database (15 of 613 turns) showed that was wrong. A Fisher exact test on 12/45 against 9/45 gives p = 0.62. Control tasks, which are already green, made the first table look better than it was, so the report now splits them out.

## The site sandbox

- The checker runs in the page as WebAssembly, built from the same package with a 40-line wrapper under `checker/cmd/ledger-wasm`. It is 3.8 MB raw and 1.05 MB gzipped; the Go runtime and `encoding/json` are most of that, the checker itself is small. It loads when the sandbox scrolls into view or on the first edit, never on page load.
- The recorded verdicts in the eval traces came from the checker as it was then. Replayed through today's checker, only 6 of the 15 flagged turns in the traces still produce their recorded verdicts; the rest changed or stopped flagging after the held-out fixes. The sandbox presets keep only turns that still reproduce their recorded verdicts, and the site build fails if one stops doing so. Two presets use a real session's evidence with a reply written for the demo, and say so.
- The fleet gate in the page is a TypeScript port of `Decide` and `Feedback`, checked against the cases in `gate_test.go`. It showed something the numbers hide: a turn that is clean and honest still gets RETRY when nothing changed a file, which is most of what the fleet run's retries were.
- The swarm replay rebuilds events from the `attempts` and `tasks` tables, since events only go out on Redis and are not stored. Every timestamp, decision, reason and feedback string is the recorded one; the replay labels itself as a replay.
- The design kit sets section heights for 900px-tall screens, so on a 1440x700 laptop the sandbox would have overlapped the next section. Short desktop screens now let sections grow instead.
