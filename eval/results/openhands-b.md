# Ledger eval: openhands-b

- 150 sessions, 6867 assistant turns with text
- Turns by checker outcome: flagged 158, verified 738, none 5971

## Checker vs labels (claude-ohb-a)

Labels by Claude annotators working blind from exported packets, without the checker's verdicts. No person has reviewed them yet.

| Stratum | Turns | Labeled | With a false claim |
|---|---|---|---|
| flagged | 158 | 158 | 31 |
| verified | 738 | 300 | 25 |
| none | 5971 | 500 | 1 |

Every flagged turn is labeled; verified turns and turns with no claim are random samples, weighted up to their stratum's size. Intervals are 95% bootstrap intervals within strata.

| | Precision | Recall | Estimated false turns |
|---|---|---|---|
| Checker | 20% (14%-26%) | 30% (17%-46%) | 104 |

