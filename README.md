# Ledger

A terminal coding agent that checks its own claims before you have to.

The agent runs `npm test`. It exits 1 with two failing tests. The agent replies
"All tests pass." Ledger prints this right under that reply:

```
[FALSE CLAIM] tests_pass c3 | model said: "All tests pass." | evidence: `npm test` exited 1 (vitest: 5 passed, 2 failed)
```

That check is deterministic, takes about a millisecond, and costs nothing: no
second model call.

```bash
git clone https://github.com/iammdzaidalam/ledger && cd ledger
npm install && npm run build && npm link
ledger "fix the failing test in src/sum.js"
echo "explain the agent loop" | ledger -p
ledger --provider ollama --model qwen2.5:7b   # fully local
```

---

## Contents

- [Overview](#overview)
- [How a claim gets checked](#how-a-claim-gets-checked)
- [The rules](#the-rules)
- [Evaluation](#evaluation)
- [System design](#system-design)
- [Project layout](#project-layout)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Configuration](#configuration)
- [Tools](#tools)
- [Supported models](#supported-models)
- [Development](#development)
- [Design notes](#design-notes)

## Overview

Most agent loops stream a tool's raw output back into the model's context and
hope it gets read correctly. Nothing stops the model from saying "tests pass"
when the exit code was 1, "created config.json" when the write failed with
EACCES, or "fixed it" when nothing was rerun after the edit.

Ledger records every Bash, Write and Edit call as evidence: exit code, stdout,
stderr, whether it ran at all, and for file edits a real unified diff. At the
end of each assistant turn, a small Go binary pulls the claims out of what the
model said and checks each one against that evidence. Anything that does not
hold up is flagged in the terminal right under the message, and with
`--feedback` it goes back to the model so the next turn has to correct it.

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

## The rules

Each rule is its own file in `checker/` with its own table-driven Go test.

| Rule | Verified when | Flagged when |
|---|---|---|
| `tests_pass` | latest test run exited 0 and its summary shows passes and no failures | exit non-zero, summary reports failures (even with exit 0, e.g. `cmd; echo $?`), no test run at all, zero tests ran, or files changed after the run |
| `lint_clean` | latest linter run exited 0 | exit non-zero, `gofmt -l` listed files (it exits 0 anyway), warnings reported when the claim says "no warnings", no linter run at all |
| `file_created` | a Write/Edit to that path succeeded, or a bash command naming it exited 0 | the write failed, or nothing ever wrote that path |
| `bug_fixed` | a non-empty diff, then a passing rerun of a test/build/lint command or of the command that failed before the edit | no file changed, no rerun after the last change, or the rerun failed |
| `command_success` | the attributed command exited 0 | it exited non-zero |
| `not_executed` | | the attributed command never started or timed out, whatever the model says |

Test summaries are parsed for vitest, jest, pytest, go test, `node --test`,
unittest, cargo and mocha. A custom script whose output contains one of those
summaries counts as a test run too.

## Evaluation

The question the eval answers: on real agent sessions, how many false success
claims does the checker catch, and how often is it wrong?

**Setup.** 14 seeded scenarios in `eval/scenarios/`, each a tiny repo with a
known ground truth: a failing test with a real bug, a test that needs a service
that does not exist, a missing `npm test` script, a `go vet` error, a
read-only directory, a test that hangs, `gofmt` drift, plus true-success
controls where the claims are true (so false positives can show up) and two
open-ended tasks. Scenarios are split into dev (rules were tuned on these) and
held-out (scored once). Sessions run on local models through Ollama with
`num_ctx`, `num_predict`, temperature and seed pinned and recorded in every
trace, inside a sandbox that only lets the agent write to its scratch dir.

**Labels.** Every assistant turn is labeled blind, without the checker's
verdict, with the kinds of false claim it contains (`eval/LABELING.md`). The
unit is one assistant turn and one claim kind. Traces are replayed through the
current checker offline, so changing a rule never needs a model rerun.

**Results so far (`eval/results/run1.md`).** 168 recorded sessions across
qwen2.5:3b, qwen2.5:7b and llama3.1:8b, with 303 assistant turns that contain
text. The checker found claims in 42 of those turns and flagged 17 of them.
Checker latency per turn is 0.1 ms at p50 and 0.3 ms at p95, with zero LLM
calls. The turns are not labeled yet, so there is no precision or recall
number; every flag is listed in the results file to review by hand.

Reproduce:

```bash
npm run checker:build
npm run eval:run -- --out eval/traces/run1 --models qwen2.5:7b,llama3.1:8b,qwen2.5:3b --modes prose,tagged --seeds 1,2
npm run eval:label -- --traces eval/traces/run1          # blind labeling CLI
npm run eval:judge -- --traces eval/traces/run1          # optional LLM judge baseline
npm run eval:score -- --traces eval/traces/run1 --labels human --judges ollama-qwen2.5-7b
```

## System design

```
                  ┌──────────────────────────────────────────────┐
   CLI args  ───▶ │                  main()                       │
   stdin     ───▶ │   parse args · load settings · build prompt   │
                  └───────────────┬────────────────┬──────────────┘
                                  │                │
                        print mode│      interactive REPL
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
              │ ollama                 │    │ Grep Find Ls          │
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
                                          rendered and optionally fed back
```

Two event streams hold the system together:

- **`StreamEvent`**: what a provider yields: `text_delta`, `tool_use_start` /
  `tool_use_input_delta` / `tool_use_end`, `message_end`.
- **`AgentEvent`**: what the loop yields to a UI: `text_delta`, `tool_start` /
  `tool_end`, `evidence`, `assistant_turn`, `grounding_check`,
  `grounding_flag`, `turn_end`, `agent_end`.

A new provider never touches the agent loop, and a new UI never touches the
providers or the grounding layer. The eval recorder is just another consumer
of `AgentEvent`.

### Why Go for the checker

The agent loop and provider adapters spend almost all their time waiting on
network streams, so TypeScript is the right tool there. The checker runs on
every assistant turn, and it is the one part where a slow or wrong check
defeats the point. One long-lived binary talking JSON lines keeps it fast,
dependency-free, and testable on its own with `go test`.

## Project layout

```
src/
├── index.ts, main.ts           # bin entry and wiring
├── agent/loop.ts               # the agent loop, grounding hook included
├── grounding/
│   ├── evidence.ts             # EvidenceLog: refs, fresh tracking
│   ├── client.ts               # talks to the checker binary
│   ├── format.ts               # flag lines and feedback text
│   └── types.ts                # wire types shared with the Go checker
├── providers/                  # claude, gemini, groq, ollama adapters
├── tools/                      # read write edit bash grep find ls, diff, workspace sandbox
├── modes/                      # print and interactive
├── session/                    # JSONL session store
└── config/, cli/

checker/                        # Go module, no third-party deps
├── main.go, protocol.go        # JSON-line loop and wire types
├── claims.go                   # sentence split, hedges, negation, claim kinds, tags
├── evidence.go                 # command families, helpers
├── testsummary.go              # test runner summary parsers
├── rules.go                    # attribution and dispatch
├── rule_*.go                   # one file per rule
└── *_test.go                   # one test file per rule, plus parsers and attribution

eval/
├── scenarios/                  # seeded fixture repos with ground truth
├── run.ts                      # records sessions as JSONL traces
├── label.ts                    # blind labeling CLI
├── judge.ts                    # optional LLM judge baseline
├── score.ts                    # offline replay, precision and recall
└── traces/, labels/, results/

docs/design/                    # design docs
```

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
ledger [message]            Interactive REPL (default)
ledger --print [message]    One-shot: stream the answer to stdout
echo "..." | ledger -p      Read the prompt from a pipe

Options
  --provider <name>   claude (default), gemini, groq, or ollama
  --model <id>        Specific model id (any local tag for ollama)
  --session <id>      Session id, written to .ledger/sessions/<id>.jsonl
  --claims <mode>     prose (default) or tagged
  --feedback          Send flagged claims back to the model to correct
  --print, -p         Non-interactive output
  --version, -v
  --help, -h
```

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
  "feedback": true,
  "systemPromptExtra": "Prefer functional style. Keep diffs small."
}
```

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

| Tool | What it does |
|------|--------------|
| `Read` | Read a file; returns content with line numbers, supports offset/limit |
| `Write` | Create or overwrite a file, making parent directories; records a diff |
| `Edit` | Replace an exact, unique string in a file; records a diff |
| `Bash` | Run a shell command (30s default, 120s max, output capped) |
| `Grep` | Regex search across file contents |
| `Find` | Locate files by glob-style name pattern |
| `Ls` | List a directory with types and sizes |

## Supported models

| Provider | Model | Context |
|----------|-------|---------|
| Claude | `claude-sonnet-4-5` | 200K |
| Claude | `claude-opus-4-1` | 200K |
| Gemini | `gemini-2.5-pro` | 1M |
| Gemini | `gemini-2.5-flash` | 1M |
| Groq | `llama-3.3-70b-versatile` | 128K |
| Groq | `llama-3.1-8b-instant` | 128K |
| Ollama | any local tag, e.g. `qwen2.5:7b`, `llama3.1:8b` | set by `num_ctx` |

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
  makes runs predictable and bounds cost.
- **Why heuristics and not a judge model.** Deterministic rules are fast,
  free, and give the same answer twice. The eval puts a number on what they
  miss, next to an LLM judge on the same turns.
- **Adding a provider** means implementing one `complete()` generator that
  emits `StreamEvent`s; nothing else changes.
