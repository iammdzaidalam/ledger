# Ledger eval: run1

- Sessions: 9 (qwen2.5:7b), assistant turns with text: 18, turns where the checker found any claim: 3
- Checker latency per turn: p50 0.2 ms, p95 0.3 ms, zero LLM calls
- Tagged mode: 0/0 turns with claims used at least one <claim> tag
- Ollama settings: num_ctx 16384, num_predict 1536, temperature 0.7

No labels found. Label with `npx tsx eval/label.ts --traces <dir>` and rerun.

## Checker flags without labels

