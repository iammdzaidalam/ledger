# Ledger

A terminal coding agent that checks what it says against what it actually did.

The agent runs `npm test`. It exits 1 with two failing tests. The agent replies
"All tests pass." Ledger prints this right under that reply:

```
[FALSE CLAIM] tests_pass c3 | model said: "All tests pass." | evidence: `npm test` exited 1 (vitest: 5 passed, 2 failed)
```

The check is a fixed set of rules, not another model. It takes about 0.1 ms per
turn and costs nothing.

**Try it in your browser:** the [playground](https://ledger-psi-umber-17.vercel.app/playground.html)
runs the real checker (compiled to WebAssembly) on recorded sessions or on text
you type, and replays recorded runs of parallel agents. The
[project site](https://ledger-psi-umber-17.vercel.app) has the overview and the
results. Both are also on [GitHub Pages](https://iammdzaidalam.github.io/ledger/).

```bash
git clone https://github.com/iammdzaidalam/ledger && cd ledger
npm install && npm run build && npm link
ledger "fix the failing test in src/sum.js"
echo "explain the agent loop" | ledger -p
ledger --provider ollama --model qwen2.5:7b   # fully local
```

## Contents

- [What Ledger does](#what-ledger-does)
- [How it is built](#how-it-is-built)
- [How a claim gets checked](#how-a-claim-gets-checked)
- [The rules](#the-rules)
- [How well it works](#how-well-it-works)
- [Ledger Fleet: several agents at once](#ledger-fleet-several-agents-at-once)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Configuration](#configuration)
- [Tools](#tools)
- [Supported models](#supported-models)
- [Project layout](#project-layout)
- [Development](#development)
- [Design notes](#design-notes)

## What Ledger does

Coding agents often report results they never got. A model can say "tests
pass" when the exit code was 1, "created config.json" when the write failed
with a permission error, or "fixed it" when nothing was rerun after the edit.

Ledger records every Bash, Write, Edit and git call the agent makes as
evidence: the exit code, the output, whether the command ran at all, and for
file edits the real diff. When the model finishes a turn, a small Go program
reads what it said, pulls out each claim ("tests pass", "file created", "bug
fixed") and compares it with the evidence. A claim the evidence contradicts is
flagged under the message. With `--validate revise`, Ledger also sends the
model the exact fact it got wrong and checks the corrected answer. When the run
ends, Ledger prints a summary of every claim and whether it held up.

Ledger also runs several agents in parallel, each on its own copy of the
repository, and only merges the work of an agent whose last turn passed the
check. That part is described in [Ledger Fleet](#ledger-fleet-several-agents-at-once).

## How it is built

Ledger has three parts:

- **The agent** (TypeScript, in `src/`). It talks to the model, runs tools,
  asks permission before changing anything, and shows the result in a terminal
  UI. It works with Claude, Gemini, Groq, or local models through Ollama.
- **The checker** (Go, in `checker/`). It has no outside dependencies. The
  agent starts it once and sends it each turn's text and evidence as one line
  of JSON; it replies with one verdict per claim.
- **The Fleet service** (Go, in `server/`, called `ledgerd`). It stores runs and
  verdicts in Postgres, keeps the state of parallel runs, and serves a live
  dashboard.

```
                  ┌──────────────────────────────────────────────┐
   CLI args  ───▶ │                  main()                       │
   stdin     ───▶ │   parse args · load settings · build prompt   │
                  └───────────────┬────────────────┬──────────────┘
                                  │                │
                        print mode│      interactive UI or REPL
                                  ▼                ▼
                  ┌────────────────────────────────────────────────┐
                  │                 runAgent()                      │
                  │  stream → check turn's claims → run tools →     │
                  │  record evidence → append results → repeat      │
                  └───────┬───────────────────────────┬────────────┘
                          │ StreamEvent                │ tool call
                          ▼                            ▼
              ┌───────────────────────┐    ┌──────────────────────┐
              │       Provider         │    │     Tool registry     │
              │ claude gemini groq     │    │ Read Write Edit Bash  │
              │ ollama                 │    │ Grep Find Ls Git*     │
              └───────────────────────┘    └──────────┬────────────┘
                                                       │ Bash Write Edit
                                                       ▼
                                             ┌──────────────────────┐
                                             │     EvidenceLog       │
                                             │  c1 c2 c3 ... + diff  │
                                             └──────────┬────────────┘
                                   turn text + evidence  ▼
                                             ┌──────────────────────┐
                                             │  grounding checker     │
                                             │  Go, JSON lines over   │
                                             │  stdin/stdout          │
                                             └──────────┬────────────┘
                                                        ▼
                                          one verdict per claim, flags
                                          rendered, false ones optionally
                                          sent back and the revision rechecked
```

Two streams of events connect the pieces:

- **`StreamEvent`** is what a provider produces: text, the start, input and
  end of each tool call, and the end of the message.
- **`AgentEvent`** is what the agent loop produces for a screen: text, tool
  start and end, evidence, the checker's verdicts, revision requests, and the
  end of the run with its summary.

A new provider never touches the agent loop, and a new screen never touches
the providers or the checker. The evaluation recorder is just another consumer
of `AgentEvent`.

**Why the checker is in Go.** The agent loop spends nearly all its time waiting
on the network, so TypeScript suits it. The checker runs on every turn and has
to be fast, exact and easy to test by itself. One long-running Go program that
speaks JSON lines has no dependencies and is tested with `go test`.

For the parallel-agent service, see [Ledger Fleet](#ledger-fleet-several-agents-at-once).

## How a claim gets checked

```
assistant turn text ──► split into sentences and clauses
                         drop plans, hedges, questions, negations, code blocks
                         classify: tests_pass · lint_clean · file_created · bug_fixed · command_success
                                  │
evidence log [c1 c2 c3 ...] ──────┤ attribute each claim:
                                  │   1. <claim ref="c3"> tag, if the model used one
                                  │   2. a command or path the sentence mentions
                                  │   3. latest evidence of the same family (tests → latest test run)
                                  │   4. latest fresh command, for a bare "done"
                                  ▼
                         run that kind's rule ──► verified · contradicted · unsupported · unverifiable
```

Claims are checked against the evidence *state* of the session, not glued to
whichever call happened to be pending. "Tests pass" is a statement about the
repo right now, so it is checked against the latest test run. That is also
how Ledger catches a claim made with no tool call at all: "I ran the tests and
they pass" with no test run in the log comes back `unsupported`.

Why this happens after the turn and not at the tool call is covered in
[docs/design/verify-after-the-turn.md](docs/design/verify-after-the-turn.md).

### Structured claims (`--claims tagged`)

With `--claims tagged`, tool results are prefixed with a ref (`[ref c3]`) and
the model is asked to wrap each claim as `<claim ref="c3">all 12 tests pass</claim>`.
That pins a claim to exactly one call. It is off by default on purpose: asking
a model to declare its claims changes how it behaves, and false claims mostly
live in plain prose. The eval reports both modes separately.

### Validation modes (`--validate`)

| Mode | What happens to a false claim |
|---|---|
| `off` | nothing, the checker is not called |
| `flag` (default) | shown under the message and in the ledger at the end |
| `revise` | also sent back to the model, which gets to revise its answer |
| `strict` | like `revise`, and if a claim is still false when the revisions run out, the answer is marked `[UNVERIFIED]` and print mode exits 2 |

`--feedback` still works and means `--validate revise`.

Only `contradicted` and `unsupported` claims go back to the model.
`verified` claims never do, and neither do `unverifiable` ones: "unverifiable"
means the evidence cannot settle it, not that the model is wrong. The
feedback is one line per claim, quoting the sentence, the verdict, the
evidence ref and the fact, plus what would make it true:

```
Ledger checked your last message against the tool output and these claims do not hold up (revision 1 of 1):
- "All tests pass." (contradicted by c3): `npm test` exited 1 (vitest: 5 passed, 2 failed). Fix the failures and rerun the tests, or say they fail.
Correct the record in your next message. Only repeat a claim if new tool output backs it.
```

The revised answer is the first later turn that makes a claim or ends
without a tool call, so the model can rerun the tests before answering. Each
original claim then comes back as `corrected` (dropped from the answer, or
now verified), `still_false`, or `new_false` for a false claim the revision
introduced. Anything still false gets another round while the budget lasts.

The budget is per flagged turn (`--max-revisions`, default 1), so a lie late
in a long run still gets its own revision. A per-run cap (default three times
the per-turn budget) stops a model that keeps lying from looping.

At the end of the run Ledger prints the ledger to stderr:

```
ledger: 4 claims, 1 verified, 1 corrected, 1 false, 1 unverifiable, 2 revision(s)
  verified     t2 c1    lint_clean    "Lint is clean."
  corrected    t2 c4    tests_pass    "All tests pass."  now verified: "All 7 tests pass now."
  FALSE        t6       file_created  "I created config.json."  unsupported after 1 revision: nothing wrote config.json
  unverifiable t8 c4    tests_pass    "Tests still pass."  files changed after the last test run (`Edit src/sum.js`)
```

Unverifiable rows are dimmed. The same data is on the `agent_end` event as
`ledger`.

## The rules

Five rules have their own file in `checker/` (`rule_*.go`), each with a
table-driven Go test. `not_executed` is a check in `rules.go` that runs
before every rule.

| Rule | Verified when | Flagged when |
|---|---|---|
| `tests_pass` | latest test run exited 0 and its summary shows passes and no failures | exit non-zero, summary reports failures (even with exit 0, e.g. `cmd; echo $?`), no test run at all, zero tests ran, files changed after the run, or the claim names more tests than ran ("all 12 pass" when 2 ran) |
| `lint_clean` | latest linter run exited 0 | exit non-zero, `gofmt -l` listed files (it exits 0 anyway), warnings reported when the claim says "no warnings", no linter run at all |
| `file_created` | a Write/Edit to that path succeeded, or a command that writes it exited 0; also covers "updated/changed X" | the write failed, nothing ever wrote that path, or every edit to it had an empty diff |
| `bug_fixed` | a non-empty diff, then a passing rerun of a test/build/lint command or of the command that failed before the edit | no file changed, no rerun after the last change, or the rerun failed |
| `command_success` | the attributed command exited 0 | it exited non-zero |
| `not_executed` | | the attributed command never started or timed out, whatever the model says |

Test summaries are parsed for vitest, jest, pytest, go test, `node --test`,
unittest, cargo and mocha. A custom script whose output contains one of those
summaries counts as a test run too.

## How well it works

Two terms are used below. **Precision** is how often a flagged turn really
contains a false claim. **Recall** is how many of the turns that contain a false
claim get flagged. A checker with high precision and low recall rarely
cries wolf but misses things; the reverse flags too much.

**Controlled runs.** 20 small repositories in `eval/scenarios/`, each with a
known answer: a failing test with a real bug, a test that needs a service that
does not exist, a missing `npm test` script, a `go vet` error, a read-only
directory, a test that hangs, `gofmt` drift, and control repositories where the
agent's claims are true (so wrong flags show up). The scenarios are split into
three groups. Dev scenarios were used to tune the rules. Held-out scenarios
were scored once. Fresh scenarios were written after the last rule change and
scored once. Sessions run on local models through Ollama, with the context size,
output limit, temperature and seed pinned and written into every trace, in a
sandbox that only lets the agent write to its scratch directory.

Every assistant turn is labelled by an annotator who does not see the
checker's verdict, using the rules in `eval/LABELING.md`. The traces are
replayed through the current checker offline, so changing a rule never needs a
new model run.

- **run1:** 168 sessions on qwen2.5:3b, qwen2.5:7b and llama3.1:8b, with 303
  assistant turns that contain text (161 held-out, 142 dev).
- **run2:** 72 sessions on the six fresh scenarios, with 134 such turns.
- **Speed:** 0.1 to 0.2 ms per turn at the median and 0.3 ms at the 95th
  percentile, with no model call.

| Measurement | Checker precision | Checker recall | LLM judge precision | LLM judge recall |
|---|---|---|---|---|
| run1 held-out, before any fix (161 turns) | 60% (3/5) | 23% (3/13) | 10% (13/134) | 100% (13/13) |
| run2 fresh scenarios, after the fixes (134 turns) | 67% (4/6) | 57% (4/7) | 7% (7/102) | 100% (7/7) |

The "LLM judge" is qwen2.5:7b asked to flag false claims, as a comparison; it
takes about 0.7 s per turn. With only 6 to 13 false turns per row the ranges
are wide; `eval/results/run1-before-fixes.md` and `eval/results/run2.md` give
them per rule.

How the rows were made: run1's held-out turns were scored once and that score
is kept. Reading the misses led to four checker fixes (see LEARNINGS.md); six
of the ten misses were formatting claims such as "no files need formatting"
that the claim extractor never picked up. After that, run1 was no longer a fair
test, so six new scenarios were written, recorded as run2 and scored once with
the fixed checker. `eval/results/run1.md` shows run1 with the fixed checker for
reference; it is not a held-out number.

**Who did the labelling.** The labels come from Claude models, not people yet.
Two independent passes labelled every scored turn and disagreed on one turn of
295. Because it is the same model both times, that agreement says less than two
people agreeing would. The one disputed turn ("Not all 12 tests pass" when 2
ran) moves run2 recall between 57% and 67%. `npm run eval:label` writes
`eval/labels/human.jsonl`, which the scoring script prefers when it exists.

What the numbers say: when the checker flags a turn it is right about two times
in three, and it catches a bit over half the false turns. The judge catches
every one but flags three of every four turns, so most of its flags are noise.
On run2 the checker's two wrong flags were the word "fixed" used as an
adjective inside a tool call printed as text, and "The other test passed."
after a run where one test passed and one failed. Its misses were "the type
mismatch issue has been addressed" with no rebuild, and "Bash command executed
to run tests" with no command at all.

**Real sessions at scale.** run1 and run2 contain only 13 and 7 turns with a
false claim, too few to trust. So the frozen checker was also run on 300
sessions from
[nebius/SWE-rebench-openhands-trajectories](https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories)
(CC-BY-4.0): Qwen3-Coder-480B working on real GitHub issues in OpenHands,
13,664 assistant turns. All 404 flagged turns, 600 of the 1,480 turns with a
verified claim, and 1,000 of the 11,780 turns with no claim were labelled, then
weighted back up to the full set (`eval/results/openhands.md`).

| 13,664 real turns | Precision | Recall | Cost per turn |
|---|---|---|---|
| Ledger checker | 21% (17-24%) | 31% (23-37%) | 0.1 ms, no model call |
| qwen2.5:7b as an LLM judge (400-turn sample) | 4% (2-7%) | 100% | 11 s, flags 93% of turns |

About 2% of turns hold a false claim. The checker does much worse here than on
the small local-model runs, for three specific reasons:

- OpenHands often writes a new reproduction or test script after a fix, and the
  checker counts that new file as a code change, so "Fixed X" after a passing
  run reads as unsupported.
- "I've successfully reproduced the issue" after a script that exits 1 is true
  (the point was to reproduce a failure), but the `command_success` rule calls
  it a lie.
- Narrow claims such as "all other tests pass" or a count quoted from an
  earlier run are checked against the latest run.

A small local judge is no better; it flags almost everything. Two annotator
passes agreed on 292 of 300 shared turns.

I fixed the first two patterns and part of the third, then measured on 150 new
sessions (6,867 turns, `eval/results/openhands-b.md`): 20% precision (14-26%)
and 30% recall (17-46%), against 19% and 41% for the unfixed checker on the same
turns. The fixes removed some wrong flags but did not move the totals, so the
headline stays at 21%. What remains needs an idea of "the full test suite" that
pattern matching on a sentence cannot provide.

Reproduce:

```bash
npm run checker:build
npm run eval:run -- --out eval/traces/run1 --models qwen2.5:7b,llama3.1:8b,qwen2.5:3b --modes prose,tagged --seeds 1,2
npm run eval:label -- --split test                       # blind labeling, held-out first
npm run eval:label                                        # then the dev turns
npm run eval:judge -- --split test                       # local LLM judge to compare against
npm run eval:import-openhands -- --count 300 --seed 11  # the OpenHands set
npm run eval:sample && npm run eval:score-sampled -- --labels claude-oh-a
npm run eval:run -- --out eval/traces/run2 --modes prose,tagged --seeds 1,2 --scenarios go-build-typo,go-vet-unreachable,py-missing-fixture,py-cli-crash,node-nested-config,node-title-bug
npm run eval:score -- --labels human,claude-a --judges ollama-qwen2.5-7b
```

## Ledger Fleet: several agents at once

`ledger swarm` takes one goal, splits it into smaller tasks, and runs one agent
per task. Each agent works in its own git worktree (a separate checkout of the
same repository), so they cannot overwrite each other. A Go server called
`ledgerd` keeps track of every task and attempt. When an agent finishes, the
server looks at the checker's verdict on its last turn and decides whether its
work may be merged, must be retried, or is rejected.

```bash
docker compose -f deploy/docker-compose.yml up -d        # postgres, redis, ledgerd, prometheus, jaeger
ledger swarm "add input validation to the CLI and update the docs" --workers 3 \
  --server http://localhost:8080 --provider ollama --model qwen2.5:7b
ledger swarm "..." --subtask "fix the parser bug" --subtask "document the flags"
open http://localhost:8080                               # live view of tasks, attempts and flagged claims
```

You can also replay recorded runs in the [playground](https://ledger-psi-umber-17.vercel.app/playground.html#swarm/1/on/0).

### Architecture

```
ledger swarm (planner, N workers, merge queue)          dashboard, SSE /events
        |  Connect/gRPC                                        ^
        v                                                      | Redis pub/sub
ledgerd  SwarmService: tasks -> attempts -> gate -------------+
         VerifyService: RecordTurn -> checker (Go) -> verdicts
         Postgres: runs, turns, verdicts, swarms, tasks, attempts, jobs
         Prometheus /metrics, OpenTelemetry (OTLP) when configured
```

- **`ledger swarm`** is the client. It plans the tasks, starts the workers, and
  merges finished branches.
- **`ledgerd`** is the server. It exposes two services over Connect, which
  speaks gRPC and plain JSON over HTTP. `VerifyService` runs the checker on a
  turn and stores the verdict. `SwarmService` holds the state of every swarm.
- **Postgres** stores everything that must survive a crash: runs, turns,
  verdicts, swarms, tasks, attempts and queued jobs.
- **Redis** carries live events to the dashboard. Without Redis, events stay in
  memory and everything else still works.
- **Prometheus and OpenTelemetry** provide metrics and traces. Tracing is off
  unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

### How a swarm runs

1. **Plan.** The planner asks the model for independent subtasks. If the answer
   is unusable it falls back to one task. `--subtask` skips planning.
2. **Work.** A worker claims a task from the server for a limited time (a
   lease), creates a worktree on branch `ledger/<swarm>/<n>`, and runs the agent
   as a child process with `--validate strict`. While it runs, the worker sends
   a heartbeat to renew the lease, and every turn is recorded on the server.
   If a worker dies, the lease runs out and another worker takes the task, so a
   run survives a crash.
3. **Decide.** When the agent exits, the server checks the last turn:
   - clean and committed: the task **passes**;
   - flagged and attempts remain: **retry**, continuing from the previous
     commit with the checker's reasons added to the prompt;
   - flagged on the last attempt: **blocked**;
   - no files changed: retry once with a hint, then **fail**.

   `--no-gate` merges whatever a worker committed. That is the baseline for the
   experiment below.
4. **Merge.** Passed branches are merged one at a time into
   `ledger/<swarm>/integration`. A conflict is rolled back and the task is
   marked as conflicted. Your own branch and working tree are never touched.
5. **Resume.** A swarm is identified by its goal and base commit, so running the
   same command after a crash reattaches to it. `--resume <id>` does the same.

Server settings are environment variables: `LEDGER_DATABASE_URL`,
`LEDGER_ADDR`, `LEDGER_REDIS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and
`LEDGER_JUDGE_MODEL` / `LEDGER_JUDGE_URL` to run an LLM judge next to the
checker.

### Design choices

| Choice | Why |
|---|---|
| Postgres as the job queue | Jobs are claimed with `FOR UPDATE SKIP LOCKED`, which lets many workers take different jobs without blocking each other. It is durable and needs no extra system. It stops being enough when claiming jobs, rather than checking them, becomes the bottleneck. |
| Workers pull work | A crashed worker only loses its lease, and workers can run on any machine that can reach the server. |
| Repeated requests are safe | Creating a swarm with the same key returns the existing swarm. Sending the same turn twice returns the stored verdict, and the same turn id with different text is rejected. |
| The optional LLM judge sits behind a circuit breaker | If the model endpoint fails, jobs wait without using up their retries, and the breaker tries one call at a time until it recovers. |
| One merge at a time | Merges into the integration branch cannot race each other, and a conflict only affects its own task. |

### Performance

Measured on one laptop (Apple M5, Postgres in Docker, 12 tool calls per turn,
using `server/cmd/loadgen`):

| | Throughput | p50 | p99 |
|---|---|---|---|
| `Check` (no storage, 32 clients) | 21-25k/s | 1.0 ms | 5.7 ms |
| `RecordTurn` (stored, 8 clients) | 3.6k/s | 2.1 ms | 4.1 ms |
| `RecordTurn` (stored, 32 clients) | 3.9k/s | 7.9 ms | 13.4 ms |
| `RecordTurn` (stored, 128 clients) | 3.6k/s | 34 ms | 71 ms |

Stored writes plateau at about 3.9k/s. The database is the limit, and extra
clients only add waiting. In these tables p50 is the typical request time and
p99 is the time the slowest 1% of requests exceed.

### Does the gate help? Gate on and off

`eval/fleet.ts` builds a repository with three independent problems per swarm
(a bug in Node, Python or Go, a failing build, a formatter complaint, plus
control tasks that are already correct). It runs `ledger swarm` with
`qwen2.5:7b` on Ollama once with the gate and once without, then runs each
problem's own verify command on the integration branch. Six groups, three seeds,
36 swarms, 54 tasks per setting. The full table is `eval/results/fleet.md`.

| Tasks with a real bug (45 per setting) | Gate on | Gate off |
|---|---|---|
| Merged and verified | 12 (27%, 16%-41%) | 9 (20%, 11%-34%) |
| Merged but verify still fails | 21 | 15 |
| Failed or conflict | 12 | 21 |
| Attempts per task | 1.56 | 1.00 |
| Wall time per swarm | 4.3 min | 2.2 min |

The ranges overlap, so 54 tasks per setting do not show that the gate improves
outcomes. What the data does show:

- All of the gate's extra merges came from the retry for "no files were
  changed", none from catching a false claim. Across both settings there were
  32 retries and 14 failures of that kind: the 7B workers often exit without
  editing anything, and the gate sends them back once with a hint instead of
  merging nothing. The checker did flag a turn in 5 of the gate-on attempts,
  but each of those attempts ended on a clean turn (the gate only looks at the
  last one), so no flag ever caused a retry or a block.
- Nothing was blocked in either setting. The gate can only stop what the
  checker can see, and the failures here were code that does not build or does
  not fix the bug, with no test-success claim to contradict. About two thirds of
  merged bug tasks still fail their verify command either way.
- The gate costs about twice the wall time, because retries rerun the agent.

The gate is a cheap filter on false claims. It does not replace running the
project's own tests before a merge.

## Getting started

Requires **Node 22+** and **Go 1.22+** to build from source. The release
workflow builds prebuilt checker binaries for macOS, Linux and Windows.

```bash
npm install
cp .env.example .env       # add any provider keys you have
npm run checker:build      # builds bin/grounding-checker
npm run dev -- "list the typescript files under src"
```

No keys? Use Ollama:

```bash
ollama pull qwen2.5:7b
npm run dev -- --provider ollama --model qwen2.5:7b "run the tests"
```

## Usage

```
ledger [message]            Interactive terminal UI (default)
ledger --no-tui [message]   The plain line-by-line REPL instead
ledger --print [message]    One-shot: stream the answer to stdout
echo "..." | ledger -p      Read the prompt from a pipe
ledger sessions             List saved sessions in this directory
ledger -p --validate strict "fix the failing test"   # exits 2 if a claim is still false

Options
  --provider <name>   claude (default), gemini, groq, or ollama
  --model <id>        Specific model id (any local tag for ollama)
  --session <id>      Session id, written to .ledger/sessions/<id>.jsonl;
                      an existing id is resumed
  --resume, -r <id>   Resume a saved session (an id prefix is enough)
  --continue, -c      Resume the most recent session
  --list-sessions     Same as `ledger sessions`
  --yes, -y           Approve every tool call without asking
  --claims <mode>     prose (default) or tagged
  --validate <mode>   off, flag (default), revise, or strict
  --max-revisions <n> Revisions allowed per flagged turn (default 1)
  --feedback          Same as --validate revise
  --print, -p         Non-interactive output
  --no-tui            Plain REPL instead of the full-screen UI
  --version, -v
  --help, -h
```

In print mode the answer goes to stdout and everything Ledger adds (flags,
revision notes, the ledger) goes to stderr. The one exception is
`--validate strict`: if a claim is still false at the end, an `[UNVERIFIED]`
line is appended to stdout too, so the answer cannot be passed on without
it, and the exit code is 2. A checker that fails to run also counts as
unverified in strict mode.

### The terminal UI

Interactive mode opens a full-screen UI when stdin and stdout are both a
terminal. It is a front end over the same event stream the REPL prints, so
nothing about the agent loop or the checker changes.

- Replies stream with basic markdown: headings, bold, italics, inline code,
  fenced code blocks and lists.
- Each tool call is one line: tool, command or path, then its evidence ref and
  outcome once it finishes (`c3 · exit 1 · 0.4s`).
- When a turn is checked, each claim gets its verdict right after the sentence
  it came from. A false claim is underlined and followed by a red tag, the
  evidence ref and the checker's reason, for example
  `All tests pass. [✗ CONTRADICTED c1: npm test exited 1]`. Verified claims
  get a dim `✓ c2`, unverifiable ones a dim `?` tag.
- With `--validate revise` or `strict`, revision requests and results show as
  their own lines, and the original claim's tag gets `→ corrected in revision`
  or `→ still false after revision`.
- At the end of each run the ledger shows as a small table.
- The side panel lists the evidence log (ref, tool, command or path, outcome)
  and every claim checked so far, and updates as the run goes.
- The status bar shows provider and model, session id, validation mode,
  evidence count and claim tallies.
- Permission prompts show above the input as the same `y` / `a` / `n` choice.
  After `n` you can type a reason for the model, or press Esc to skip it.
- Provider errors show as one line and the session carries on.

| Key | Action |
|---|---|
| Enter | send |
| Ctrl+J, Alt+Enter, or `\` before Enter | new line in the input |
| Up / Down | move between input lines, then through earlier messages |
| `/` | command hints; Up/Down pick, Tab completes, Enter runs |
| Ctrl+O | show or hide the evidence and claims panel |
| PgUp / PgDn, Ctrl+B / Ctrl+F | scroll the transcript a page |
| Shift+Up / Shift+Down | scroll three lines |
| Esc | jump back to the latest output |
| Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+W, Ctrl+K | line start, line end, delete to start, delete word, delete to end |
| Ctrl+C | cancel the run (or a pending prompt); clear the input; quit when idle |
| Ctrl+D | quit when the input is empty |

Colour is limited to blue for the interface, red for contradicted and
unsupported claims, and dim text for anything unverifiable. `NO_COLOR` turns
colour off; the verdict words still show. `--no-tui`, or `"tui": false` in
settings, gives the old REPL, which is also what runs when stdin or stdout is
not a terminal.

Cancelling stops reading events from the run right away, but the loop has no
abort signal yet, so a command that is already running finishes in the
background and its evidence entry still lands in the log.

### Permissions

Read-only tools (Read, Grep, Find, Ls, GitStatus, GitDiff, GitLog, GitShow,
GitBranch) never ask. Anything that can change the project (Write, Edit, Bash,
GitAdd, GitCommit, GitCheckout) asks first:

```
Ledger wants to run Bash: npm test -- --run
  y  yes, this once
  a  yes, and allow `npm test` commands for the rest of this session
  n  no, and tell the model why
allow? [y/a/n]
```

`a` remembers the tool for the session, and for Bash it remembers the command
prefix (`npm test`, `go vet`, `ls`). A compound command like
`npm test && rm -rf build` only runs without asking if every part is allowed.
Commands with `$(...)`, backticks or a redirect to a file are never remembered.
On `n` the reason you type goes back to the model as the tool result.

A denied call is still recorded as evidence with `executed: false`, so if the
model later says it ran the command or created the file, the `not_executed`
rule flags it.

`--yes` approves everything. In print mode with no terminal on stdin (a pipe,
CI) Ledger cannot ask, so it denies the call, prints why on stderr, and tells
the model; pass `--yes` or list the allowed tools in settings. The
`LEDGER_WORKSPACE` sandbox still applies after a call is approved.

### Sessions

Every run is saved to `.ledger/sessions/<id>.jsonl`: messages, every evidence
entry, every claim verdict, and compaction markers. `--resume <id>` or
`--continue` loads the conversation and the evidence log, so a claim made after
resuming ("I already ran the tests") is checked against what actually ran
before. Refs carry on from where they stopped.

### Context compaction

When the conversation passes about 70% of the model's context window (for
Ollama, `LEDGER_OLLAMA_NUM_CTX`), older turns are replaced by a short summary
written by the same model. The split never separates a tool call from its
result. If the summary call fails, a plain list of the user's requests and the
tool calls is used instead. The evidence log lives outside the message history
and is never compacted, so claims made after compaction are still checked
against the full record.

### Slash commands

| Command | What it does |
|---|---|
| `/help` | List the commands |
| `/clear` | Drop the conversation history; the evidence log is kept |
| `/model [id]` | List the models for this provider, or switch model |
| `/provider [name]` | List providers and whether their key is set, or switch |
| `/sessions` | List saved sessions |
| `/resume <id>` | Load a saved session, evidence log included |
| `/compact` | Summarise older turns now |
| `/evidence` | Print the evidence log: ref, tool, command or path, outcome |
| `/claims` | Print every claim checked this session and its verdict |
| `/exit` | Quit (`/quit` works too) |

The registry lives in `src/commands/` and only talks to an `ActiveSession` and
a `print` function, so another front end can reuse it.

### Provider errors

Auth, rate-limit, context-length, network and unknown-model failures from any
provider come out as one line, for example:

```
Claude API rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY.
Groq API rate limit or quota reached for openai/gpt-oss-120b. Retry in about 20s, or switch with --model or /model.
Could not reach Ollama at http://127.0.0.1:11434. Is it running? Start it with `ollama serve`.
Ollama has no model "qwen3:4b". Pull it with `ollama pull qwen3:4b`.
```

In the UI and the REPL the session keeps going after an error.

## Configuration

Settings merge from three sources, each overriding the previous:

1. Global: `~/.ledger/settings.json`
2. Project: `.ledger/settings.json`
3. Environment: `LEDGER_PROVIDER`, `LEDGER_MODEL`

```jsonc
// .ledger/settings.json
{
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "claimsMode": "prose",
  "validate": "revise",
  "maxRevisions": 1,
  "maxRevisionsPerRun": 3,
  "systemPromptExtra": "Prefer functional style. Keep diffs small.",
  "permissions": {
    "mode": "ask",
    "allow": ["Edit", "GitAdd", "Bash(npm test)", "Bash(go vet)"]
  },
  "contextLimit": 32000,
  "autoCompact": true,
  "tui": true
}
```

| Key | Effect |
|---|---|
| `permissions.mode` | `ask` (default), `allow` (same as `--yes`) or `deny` (only what `allow` lists runs) |
| `permissions.allow` | tools that never ask: a tool name, or `Bash(<prefix>)` for one command prefix |
| `contextLimit` | override the context window used for compaction, in tokens |
| `validate` | `off`, `flag` (default), `revise` or `strict`; `"feedback": true` is still read as `revise` |
| `maxRevisions` | revisions allowed per flagged turn (default 1) |
| `maxRevisionsPerRun` | cap on revisions across the whole run (default 3 times `maxRevisions`) |
| `autoCompact` | set `false` to turn off automatic compaction (`/compact` still works) |
| `tui` | set `false` to always use the plain REPL in interactive mode |

Command-line flags win over settings.

| Variable | Effect |
|---|---|
| `OLLAMA_HOST` | Ollama address, default `http://127.0.0.1:11434` |
| `LEDGER_OLLAMA_NUM_CTX` | context window sent to Ollama, default 16384 |
| `LEDGER_OLLAMA_NUM_PREDICT` | cap on tokens per turn |
| `LEDGER_SEED` | sampling seed, for reproducible runs |
| `LEDGER_TEMPERATURE` | default sampling temperature for Ollama |
| `LEDGER_WORKSPACE` | confine Write/Edit to this dir, and on macOS run Bash under `sandbox-exec` with writes limited to it |
| `LEDGER_CHECKER_PATH` | use a specific checker binary |

## Tools

| Tool | Asks first | What it does |
|------|---|--------------|
| `Read` | no | Read a file; returns content with line numbers, supports offset/limit |
| `Write` | yes | Create or overwrite a file, making parent directories; records a diff |
| `Edit` | yes | Replace an exact, unique string in a file; records a diff |
| `Bash` | yes | Run a shell command (30s default, 120s max, output capped) |
| `Grep` | no | Regex search across file contents |
| `Find` | no | Locate files by glob-style name pattern |
| `Ls` | no | List a directory with types and sizes |
| `GitStatus` | no | `git status --short --branch` |
| `GitDiff` | no | Unstaged changes, `staged`, or `base`/`target` refs; `paths`, `stat` |
| `GitLog` | no | One line per commit; `limit`, `ref`, `path`, `author` |
| `GitShow` | no | One commit's message and patch; `stat`, `path` |
| `GitBranch` | no | List branches; `all` includes remote-tracking ones |
| `GitAdd` | yes | Stage `paths` |
| `GitCommit` | yes | Commit what is staged with `message`; `amend` |
| `GitCheckout` | yes | Switch to `branch` (`create` makes it), or restore `paths` from HEAD |

The git tools run `git` directly with an argument list, never through a shell,
and refuse refs that start with `-` so a ref cannot turn into an option. Each
call is recorded as `Git` evidence with the command line it ran
(`git commit -m 'fix sum'`), exit code, stdout and stderr, so "committed the
fix" is checked like any other command claim. Git evidence never counts as a
test, lint or build run, so a commit message that says `make test` does not
make "tests pass" true. Eval runs only offer the original seven tools
(`CORE_TOOLS`), so new runs stay comparable with run1. Under `LEDGER_WORKSPACE`
they run in the same macOS sandbox as Bash and refuse paths outside it.
Merge, rebase, push, stash and the rest still go through Bash.

## Supported models

| Provider | Model | Context |
|----------|-------|---------|
| Claude | `claude-sonnet-5-5` (default) | 200K |
| Claude | `claude-opus-5-5` | 200K |
| Claude | `claude-haiku-4-5` | 200K |
| Claude | `claude-sonnet-4-5` | 200K |
| Gemini | `gemini-2.5-pro` (default) | 1M |
| Gemini | `gemini-2.5-flash` | 1M |
| Gemini | `gemini-2.5-flash-lite` | 1M |
| Gemini | `gemini-3.1-pro-preview` | 1M |
| Gemini | `gemini-3-flash-preview` | 1M |
| Groq | `openai/gpt-oss-120b` (default) | 128K |
| Groq | `openai/gpt-oss-20b` | 128K |
| Groq | `llama-3.3-70b-versatile` | 128K |
| Groq | `llama-3.1-8b-instant` | 128K |
| Ollama | any local tag, e.g. `qwen2.5:7b`, `llama3.1:8b` | set by `num_ctx` |

Every id above is in the model list of the matching provider SDK
(`@anthropic-ai/sdk` 0.131, `@google/genai` 1.52, `groq-sdk` 1.6).

## Project layout

```
src/
├── index.ts, main.ts           # bin entry and wiring
├── agent/
│   ├── loop.ts                 # the agent loop, grounding hook included
│   └── compaction.ts           # summarise older turns near the context limit
├── grounding/
│   ├── evidence.ts             # EvidenceLog: refs, fresh tracking
│   ├── client.ts               # talks to the checker binary
│   ├── validation.ts           # validation modes, revision budget, the run's ledger
│   ├── format.ts               # flag lines, feedback text, ledger summary
│   └── types.ts                # wire types shared with the Go checker
├── permissions/                # ask-before-change policy, bash prefix rules, terminal prompt
├── providers/                  # claude, gemini, groq, ollama adapters, readable errors
├── tools/                      # read write edit bash grep find ls, git tools, diff, workspace sandbox
├── commands/                   # slash command registry and the built-in commands
├── modes/                      # print and interactive, shared turn runner
├── tui/                        # full-screen Ink UI
│   ├── run.tsx, app.tsx        # entry, layout, keys, run and command wiring
│   ├── state.ts                # pure reducer: agent events in, UI state out
│   ├── markdown.ts, text.ts    # markdown to styled lines, wrapping, widths
│   ├── verdicts.ts             # which sentence gets which verdict mark
│   ├── layout.ts               # transcript, ledger table, panel and status lines
│   ├── editor.ts, input.tsx    # multi-line input and command hints
│   ├── permission.ts           # asker that queues prompts for the UI
│   └── transcript.tsx, panel.tsx, permission-prompt.tsx, status-bar.tsx, lines.tsx
├── session/                    # JSONL session store, resume, the active session
├── swarm/                      # ledger swarm: planner, worktrees, workers, merge queue, client
├── server/                     # recorder that streams a session's turns to ledgerd
└── config/, cli/

checker/                        # Go module, no third-party deps
├── cmd/grounding-checker/      # JSON-line loop that the CLI spawns
├── protocol.go                 # wire types
├── claims.go                   # sentence split, hedges, negation, claim kinds, tags
├── evidence.go                 # command families, helpers
├── testsummary.go              # test runner summary parsers
├── rules.go                    # attribution and dispatch
├── rule_*.go                   # one file per rule
└── *_test.go                   # one test file per rule, plus parsers and attribution

server/                         # Go service: verification, swarm state machine, dashboard
├── proto/ledger/v1/            # VerifyService and SwarmService
├── cmd/ledgerd, cmd/loadgen    # the server and its load generator
└── internal/                   # store, queue, breaker, verify, orch, events, telemetry, web

deploy/                         # Dockerfile, compose stack, prometheus config

site/                           # project site and playground (React, Vite; the checker runs as WebAssembly)

eval/
├── scenarios/                  # seeded fixture repos with ground truth
├── run.ts                      # records sessions as JSONL traces
├── label.ts                    # blind labeling CLI
├── judge.ts                    # optional LLM judge baseline
├── score.ts                    # offline replay, precision and recall
├── import-openhands.ts, sample.ts, score-sampled.ts   # real traces at scale
├── fleet.ts, score-fleet.ts    # gate on vs gate off experiment
└── traces/, labels/, results/

docs/design/                    # design docs
```

## Development

```bash
npm run dev              # run from source
npm run build            # dist/ + checker for this machine
npm run typecheck        # src, test and eval
npx biome check .        # lint + format
npx vitest run           # TS suites, against the real checker binary
go -C checker test ./... # checker rules
```

CI runs all of the above on Linux and macOS. Tagging `v*` publishes to npm
with prebuilt checker binaries for five platforms.

## Design notes

- **Why the check happens after the turn.** A claim about a result only
  exists once the model has seen the result and spoken again. See the
  [design doc](docs/design/verify-after-the-turn.md).
- **Why a turn cap.** Tool-using models can loop. A hard `maxTurns` bound
  makes runs predictable and bounds cost. Revisions have their own budget per
  flagged turn and a cap per run for the same reason.
- **Why heuristics and not a judge model.** Deterministic rules are fast,
  free, and give the same answer twice. The eval puts a number on what they
  miss, next to an LLM judge on the same turns.
- **Adding a provider** means implementing one `complete()` generator that
  emits `StreamEvent`s; nothing else changes.
