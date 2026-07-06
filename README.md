# Ledger

A terminal coding agent that doesn't just trust its own transcript. Same idea
as minimal agents like cogent - a model with filesystem/shell tools running an
autonomous loop - plus one thing those don't have: every bash call gets
checked against what actually happened before the model's summary reaches you.

```bash
ledger "find every TODO in src/ and tell me what's left"
echo "explain the agent loop" | ledger -p
ledger                       # interactive REPL
```

## Why

Agents like this one hallucinate success. The model says "tests pass" when
the exit code was 1, or "done" when the command never ran because of a
timeout or a bad arg. Nothing checks the claim against the actual bytes the
tool returned, you just have to trust the transcript. Ledger adds that check.

## How grounding works

Every bash call produces a `VerifiedResult`: exit code, whether it actually
executed, stdout/stderr, and duration. Once the model's next turn comes in,
that text plus the raw evidence gets sent to a small Go binary
(`checker/`) that runs three deterministic checks, no LLM involved, just
string and exit-code matching:

1. The command never actually executed - hard fail, no matter what's claimed.
2. Exit code says failure but the model's text uses success language.
3. Both stdout and stderr are empty on something that looks like a test/build
   command - flagged as unverifiable rather than silently passed through.

When a check trips, you see it immediately in the terminal: `[UNVERIFIED
CLAIM] Bash exited 1 - model said: "..." - evidence: ...`

This is a heuristic, not a proof system. The string matching for "did the
model claim success" is crude by design and will have false positives and
negatives, especially early on. That's a known tradeoff for v1, not an
oversight - see `terminal-agent-prd.md` for the reasoning.

## Project layout

```
src/
  index.ts, main.ts, types.ts     bin entry, wiring, shared message shape
  cli/args.ts                     argument parsing
  config/                         settings cascade, system prompt assembly
  providers/                      claude.ts, gemini.ts, groq.ts + registry
  tools/                          read, write, edit, bash, grep, find, ls
  grounding/                      talks to the Go checker, formats the flag
  agent/loop.ts                   the agent loop
  session/store.ts                append-only JSONL, no resume yet
  modes/                          print (one-shot) and interactive (REPL)

checker/                          Go module: protocol, rules, tests
bin/grounding-checker             build output (gitignored)
test/                             vitest suites
```

## Getting started

Requires Node 22+, Go 1.22+, and at least one provider key.

```bash
npm install
cp .env.example .env      # add your key(s)
npm run checker:build     # builds bin/grounding-checker
```

```bash
npm run dev -- "list the typescript files under src"
npm run dev -- --provider gemini "explain what this project does"
```

## Development

```bash
npm run dev            # run from source
npm run check           # biome lint + format check
npm test                # vitest
npm run checker:test    # go test ./checker/...
```

## What's not here yet

No context compaction, no session resume/multi-session management, no
concurrent tool-call grounding. All deliberate - see the PRD's non-goals.
