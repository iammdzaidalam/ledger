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

Ledger records every Bash, Write, Edit and git call as evidence: exit code,
stdout, stderr, whether it ran at all, and for file edits a real unified diff. At the
end of each assistant turn, a small Go binary pulls the claims out of what the
model said and checks each one against that evidence. Anything that does not
hold up is flagged in the terminal right under the message. With
`--validate revise` it goes back to the model with the exact fact it got
wrong, and the revised answer is checked again. When the run ends, Ledger
prints the ledger: every claim the model made, its final verdict, and whether
it was corrected.

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

## Evaluation

The question the eval answers: on real agent sessions, how many false success
claims does the checker catch, and how often is it wrong?

**Setup.** 20 seeded scenarios in `eval/scenarios/`, each a tiny repo with a
known ground truth: a failing test with a real bug, a test that needs a service
that does not exist, a missing `npm test` script, a `go vet` error, a
read-only directory, a test that hangs, `gofmt` drift, plus true-success
controls where the claims are true (so false positives can show up) and two
open-ended tasks. Scenarios are split into dev (rules were tuned on these),
held-out (scored once, in run1) and fresh (six written after the last rule
change, recorded as run2 and scored once). Sessions run on local models through Ollama with
`num_ctx`, `num_predict`, temperature and seed pinned and recorded in every
trace, inside a sandbox that only lets the agent write to its scratch dir.

**Labels.** Every assistant turn is labeled blind, without the checker's
verdict, with the kinds of false claim it contains (`eval/LABELING.md`). The
unit is one assistant turn and one claim kind. Traces are replayed through the
current checker offline, so changing a rule never needs a model rerun.

**Runs.** run1 is 168 sessions across qwen2.5:3b, qwen2.5:7b and
llama3.1:8b, with 303 assistant turns that contain text (161 held-out, 142
dev). run2 is 72 sessions on the six fresh scenarios, with 134 such turns.
Replayed through the current checker, run1 has claims in 51 turns and 24 flags
across 18 turns; run2 has claims in 13 turns and 7 flags across 6 turns.
Checker latency per turn is 0.1 to 0.2 ms at p50 and 0.3 ms at p95, with zero
LLM calls.

**Precision and recall.** Labels say which turns hold a false claim; the
checker and an LLM judge are scored against them, per turn.

| Measurement | Checker precision | Checker recall | LLM judge precision | LLM judge recall |
|---|---|---|---|---|
| run1 held-out, before any fix (161 turns) | 60% (3/5) | 23% (3/13) | 10% (13/134) | 100% (13/13) |
| run2 fresh scenarios, after the fixes (134 turns) | 67% (4/6) | 57% (4/7) | 7% (7/102) | 100% (7/7) |

The checker costs 0.1 ms per turn with no model call. The judge is qwen2.5:7b
on the same machine, at about 0.7 s per turn. With 6 to 13 false turns per row the
intervals are wide; `eval/results/run1-before-fixes.md` and
`eval/results/run2.md` have them per rule.

How the rows were made. run1's held-out turns were scored once, blind, and
that score is kept in `run1-before-fixes.md`. Reading the misses then led to
four checker fixes (see LEARNINGS.md). Six of the ten misses were formatting
claims such as "no files need formatting" that the extractor never picked
up. After that run1 was no longer a fair test, so six new scenarios were
written and recorded as run2 (72 sessions, the `fresh` split), and scored
once with the fixed checker. `eval/results/run1.md` shows run1 with the fixed
checker for reference; it is not a held-out number.

The labels come from Claude annotators, not a person yet. Two independent
passes labeled every scored turn blind, from the same packets `eval:label`
shows, and disagreed on one turn of 295 (Cohen's kappa 0.97). They are the
same model, so that agreement says less than two people agreeing would. The
disputed turn ("Not all 12 tests pass" when 2 ran) moves run2 recall between
57% and 67%. `npm run eval:label` writes `eval/labels/human.jsonl`, which
`eval:score` prefers.

What the numbers say: when the checker flags a turn it is right about two
times in three, and it now catches a bit over half of the false turns. The
LLM judge catches every one but flags three of every four turns, so most of
its flags are noise. On run2 the checker's two wrong flags were "fixed" used
as an adjective inside a tool call printed as text, and "The other test
passed." after a run where one test passed and one failed. Its misses were
"the type mismatch issue has been addressed" with no rebuild, and "Bash
command executed to run tests" with no command at all.

Reproduce:

```bash
npm run checker:build
npm run eval:run -- --out eval/traces/run1 --models qwen2.5:7b,llama3.1:8b,qwen2.5:3b --modes prose,tagged --seeds 1,2
npm run eval:label -- --split test                       # blind labeling, held-out first
npm run eval:label                                        # then the dev turns
npm run eval:judge -- --split test                       # local LLM judge to compare against
npm run eval:run -- --out eval/traces/run2 --modes prose,tagged --seeds 1,2 --scenarios go-build-typo,go-vet-unreachable,py-missing-fixture,py-cli-crash,node-nested-config,node-title-bug
npm run eval:score -- --labels human,claude-a --judges ollama-qwen2.5-7b
```

## System design

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

Two event streams hold the system together:

- **`StreamEvent`**: what a provider yields: `text_delta`, `tool_use_start` /
  `tool_use_input_delta` / `tool_use_end`, `message_end`.
- **`AgentEvent`**: what the loop yields to a UI: `text_delta`, `tool_start` /
  `tool_end`, `evidence`, `assistant_turn`, `grounding_check`,
  `grounding_flag`, `grounding_revision_requested`,
  `grounding_revision_result`, `turn_end`, `agent_end` (with the run's
  `ledger`).

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
