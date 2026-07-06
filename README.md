# Ledger

A terminal coding agent that checks its own claims before you have to.

```bash
ledger "find every TODO in src/ and tell me what's left"
echo "explain the agent loop" | ledger -p
ledger                       # interactive REPL
```

---

## Contents

- [Overview](#overview)
- [Features](#features)
- [System design](#system-design)
- [The grounding layer](#the-grounding-layer)
- [Project layout](#project-layout)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Configuration](#configuration)
- [Tools](#tools)
- [Supported models](#supported-models)
- [Development](#development)
- [Design notes](#design-notes)

## Overview

Most agent loops stream a tool's raw output back into the model's context and
just hope it gets read correctly. Nothing stops the model from saying "tests
pass" when the exit code was 1, or "done" when the command timed out and
never actually ran. You only find out later, if you're lucky enough to notice.

Ledger adds a deterministic check between the tool call and the summary you
see. Every bash execution is captured as raw evidence, and once the model
makes a claim about it, a small Go binary checks that claim against the exit
code and output before it reaches your terminal. If they don't match, you see
a flag right there, not three turns later when it's harder to untangle.

## Features

- **Grounded bash execution.** Every command's exit code, stdout/stderr, and
  whether it actually ran gets checked against what the model says happened
  next, by a separate deterministic process, not another LLM call.
- **Three providers, one interface.** Claude, Gemini, and Groq implement a
  common `Provider` contract. Switching is a single flag.
- **Streaming end to end.** Async generators carry tokens from the HTTP
  response through the agent loop to stdout.
- **Seven filesystem and shell tools.** `Read`, `Write`, `Edit`, `Bash`,
  `Grep`, `Find`, `Ls`, each a self-contained module with a JSON-Schema
  signature the model sees.
- **Provider-agnostic message format.** An internal content-block model
  (text / tool-use / tool-result) is translated per provider.
- **Layered configuration.** Global, project, and environment settings merge
  in a predictable order of precedence.
- **Two run modes.** A one-shot print mode for pipes and scripts, and a
  readline REPL for interactive sessions.
- **Session persistence.** Conversations are stored as append-only JSONL.

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
                  │   stream → collect tool calls → execute tools   │
                  │   → check bash claims → append results → repeat │
                  └───────┬───────────────────────────┬────────────┘
                          │ StreamEvent                │ tool call
                          ▼                            ▼
              ┌───────────────────────┐    ┌──────────────────────┐
              │       Provider         │    │     Tool registry     │
              │ claude │ gemini │ groq │    │ Read Write Edit Bash  │
              │  (adapters → SDKs)     │    │ Grep Find Ls          │
              └───────────────────────┘    └──────────┬────────────┘
                          │                            │ bash only
                          ▼                            ▼
                   provider APIs             ┌──────────────────────┐
                                             │  grounding checker     │
                                             │  (Go binary, stdin/    │
                                             │   stdout JSON lines)   │
                                             └──────────┬────────────┘
                                                        ▼
                                                 VerifiedResult
                                            fed back into the loop
```

Two event streams hold the system together:

- **`StreamEvent`**: what a provider yields, `text_delta`,
  `tool_use_start` / `tool_use_input_delta` / `tool_use_end`, `message_end`.
  Each provider's only job is turning its SDK's chunks into this vocabulary.
- **`AgentEvent`**: what the loop yields to a UI, `agent_start`, `text_delta`,
  `tool_start` / `tool_end`, `grounding_flag`, `turn_end`, `agent_end`.

This separation means a new provider never touches the agent loop, and a new
UI never touches the providers or the grounding layer.

### The agent loop

`runAgent` (`src/agent/loop.ts`) is the core:

1. Send the message history to the provider and stream the response.
2. Render text as it arrives; reassemble tool calls from their streamed
   fragments (providers deliver arguments in pieces, keyed by id).
3. Check any bash results still pending from the previous round against this
   turn's text, and flag whatever doesn't match the evidence.
4. If the turn produced no tool calls, stop.
5. Otherwise run each tool, append the results as a new user turn, and loop.
6. Cap at `maxTurns` (default 20) so a misbehaving model cannot run forever.

One subtlety: continuation is decided by whether the assistant's response
actually contains a `tool_use` block, not by trusting the provider's reported
stop reason. Some providers report an end-of-turn signal even when they did
call a tool, so this keeps one rule true across all three.

## The grounding layer

This is the actual reason the project exists. A model claiming a command
succeeded is not the same thing as it having succeeded, and nothing in a
typical agent loop checks the difference.

Every bash call produces raw evidence before any claim exists to check it
against:

```ts
interface ToolExecution {
  tool: string;
  args: Record<string, unknown>;
  raw_stdout: string;
  raw_stderr: string;
  exit_code: number | null;
  executed: boolean;      // did the process actually start and run
  duration_ms: number;
}
```

The claim about that result always shows up in the model's *next* turn, after
the tool result has already been appended to the conversation. So checking it
is naturally a step that happens once that next turn streams in, not
something bolted onto the tool call itself. Once it arrives, the raw evidence
and the claimed text get sent as one line of JSON to a small, dependency-free
Go binary (`checker/`), which runs three deterministic rules and hands back a
verdict, no LLM involved:

1. **The command never actually executed.** Hard fail, regardless of what the
   model says, since there's nothing to be right or wrong about if it never ran.
2. **Exit code is non-zero, but the model's text uses success language**
   ("done", "fixed", "passes", and so on).
3. **Both stdout and stderr came back empty on something that looks like a
   test or build command.** Flagged as unverifiable rather than silently
   passed through. Empty output from `ls` on an empty directory is fine,
   empty output from `npm test` is suspicious.

When a check trips, it surfaces immediately in the terminal:

```
[UNVERIFIED CLAIM] Bash exited 1 | model said: "All tests pass now." | evidence: ModuleNotFoundError: no module named foo
```

Why Go for this one piece and not the whole system: the agent loop and
provider adapters spend almost all their time waiting on network streams, so
TypeScript is the right tool there. The checker is different, it's a
CPU-bound pattern match that runs on every single bash call, and it's the one
part of the system where a slow or buggy check would defeat the entire point.
A small binary talking JSON lines over stdin/stdout keeps that path fast and
easy to read start to finish.

This is a heuristic, not a proof system. String matching for "did the model
claim success" will have false positives and negatives, especially early on.
That's an accepted tradeoff for a first version, not an oversight.

## Project layout

```
src/
├── index.ts               # bin entry point
├── main.ts                # wiring: args → settings → prompt → mode
├── types.ts                # shared message / content-block types
├── cli/
│   └── args.ts            # argument parser, help, version
├── config/
│   ├── settings.ts        # global/project/env settings cascade
│   └── system-prompt.ts   # prompt assembly + project context files
├── providers/
│   ├── types.ts           # Provider / StreamEvent / ModelInfo contracts
│   ├── claude.ts           # Claude adapter
│   ├── gemini.ts            # Gemini adapter
│   ├── groq.ts              # Groq adapter
│   └── index.ts             # provider factory + model registry
├── tools/
│   ├── types.ts            # Tool contract + result helpers
│   ├── {read,write,edit,bash,grep,find,ls}.ts
│   └── index.ts             # tool registry + JSON-Schema export
├── grounding/
│   ├── types.ts             # wire types shared with the Go checker
│   ├── client.ts             # spawns and talks to the checker binary
│   ├── claim-extractor.ts    # pulls claim text out of the next turn
│   └── format.ts             # renders a flagged result as one terminal line
├── agent/
│   ├── types.ts
│   └── loop.ts               # the agent loop, grounding hook included
├── session/
│   ├── types.ts
│   └── store.ts               # JSONL read/append
└── modes/
    ├── print.ts               # one-shot streaming to stdout
    └── interactive.ts          # readline REPL

checker/                       # separate Go module
├── main.go                    # stdin/stdout JSON-line loop
├── protocol.go                 # CheckRequest / VerifiedResult structs
├── rules.go                    # the three deterministic rules
└── *_test.go                   # table-driven tests per rule

test/                           # provider, tool, agent, and grounding suites
```

## Tech stack

| Layer | Choice |
|---|---|
| Agent loop, CLI, provider adapters | TypeScript (strict), ESM, Node 22+ |
| Grounding checker | Go, single static binary, no third-party deps |
| Model SDKs | `@anthropic-ai/sdk`, `@google/genai`, `groq-sdk` |
| Terminal output | `consola` |
| Session storage | append-only JSONL |
| Testing | Vitest (TS side), Go's built-in `testing` (checker side) |

## Getting started

Requires **Node 22+**, **Go 1.22+**, and at least one provider key.

```bash
npm install
cp .env.example .env       # add your key(s)
npm run checker:build      # builds bin/grounding-checker
```

```bash
# .env
ANTHROPIC_API_KEY=...      # https://console.anthropic.com
GEMINI_API_KEY=...         # https://aistudio.google.com/apikey
GROQ_API_KEY=...           # https://console.groq.com/keys
```

```bash
npm run dev -- "list the typescript files under src"
```

## Usage

```
ledger [message]            Interactive REPL (default)
ledger --print [message]    One-shot: stream the answer to stdout
echo "..." | ledger -p      Read the prompt from a pipe

Options
  --provider <name>   claude (default), gemini, or groq
  --model <id>        Specific model (see supported models below)
  --print, -p         Non-interactive output
  --version, -v
  --help, -h
```

```bash
ledger --provider gemini "refactor src/tools/grep.ts"
```

## Configuration

Settings merge from three sources, each overriding the previous:

1. Global: `~/.ledger/settings.json`
2. Project: `.ledger/settings.json`
3. Environment: `LEDGER_PROVIDER`, `LEDGER_MODEL`

```jsonc
// .ledger/settings.json
{
  "provider": "groq",
  "model": "llama-3.3-70b-versatile",
  "systemPromptExtra": "Prefer functional style. Keep diffs small."
}
```

The system prompt is assembled at startup from base instructions, the live
tool list, and the first of these files found in the working directory:
`AGENTS.md`, `CLAUDE.md`, `.context`, `.ledger/context.md`.

## Tools

| Tool | What it does |
|------|--------------|
| `Read` | Read a file; returns content with line numbers, supports offset/limit |
| `Write` | Create or overwrite a file, making parent directories |
| `Edit` | Replace an exact, unique string in a file |
| `Bash` | Run a shell command (30s timeout, output capped, grounded) |
| `Grep` | Regex search across file contents |
| `Find` | Locate files by glob-style name pattern |
| `Ls` | List a directory with types and sizes |

A tool is an object implementing the `Tool` interface: a name, a
description, a JSON-Schema `inputSchema`, and an async `execute`. Register it
in `src/tools/index.ts` and it is immediately offered to the model.

## Supported models

| Provider | Model | Context |
|----------|-------|---------|
| Claude | `claude-sonnet-4-5` | 200K |
| Claude | `claude-opus-4-1` | 200K |
| Gemini | `gemini-2.5-pro` | 1M |
| Gemini | `gemini-2.5-flash` | 1M |
| Groq | `llama-3.3-70b-versatile` | 128K |
| Groq | `llama-3.1-8b-instant` | 128K |

Adding a model is one entry in `src/providers/index.ts`.

## Development

```bash
npm run dev            # run from source
npm run build           # tsc → dist/
npm run check            # biome lint + format check
npm test                 # vitest
npm run checker:build    # go build → bin/grounding-checker
npm run checker:test     # go test ./checker/...
```

## Design notes

- **Why the grounding check happens after the next turn, not during tool
  dispatch.** The claim about a result only exists once the model has spoken
  again. Checking earlier would mean checking against nothing.
- **Why Go for the checker specifically, not the whole system.** It's the one
  part of the loop that runs on every single tool call and needs to stay out
  of Node's event loop while it does its pattern matching. Simple and fast
  beats clever here.
- **Why a turn cap.** Tool-using models can loop. A hard `maxTurns` bound
  makes runs predictable and bounds cost.
- **Why the checker is upfront about being a heuristic.** Deterministic
  string matching for "did the model claim success" is crude by nature. It's
  meant to catch the obvious, embarrassing cases, not to be a formal
  verifier.
- **Adding a provider** means implementing one `complete()` generator that
  emits `StreamEvent`s; nothing else in the system changes.
