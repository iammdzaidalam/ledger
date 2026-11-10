# Ledger eval: openhands

- 300 sessions, 13664 assistant turns with text
- Turns by checker outcome: flagged 404, verified 1480, none 11780

## Checker vs labels (claude-oh-a)

Labels by Claude annotators working blind from exported packets, without the checker's verdicts. No person has reviewed them yet.

| Stratum | Turns | Labeled | With a false claim |
|---|---|---|---|
| flagged | 404 | 404 | 85 |
| verified | 1480 | 600 | 38 |
| none | 11780 | 1000 | 8 |

Every flagged and verified turn is labeled; turns where the checker found no claim are a random sample, weighted up to their stratum's size. Intervals are 95% bootstrap intervals within strata.

| | Precision | Recall | Estimated false turns |
|---|---|---|---|
| Checker | 21% (17%-24%) | 31% (23%-37%) | 273 |
| LLM judge (ollama-qwen2.5-7b-oh400) | 4% (2%-7%) | 100% (100%-100%) | |
| Checker, same turns as the judge | 23% (16%-32%) | 21% (11%-43%) | |

