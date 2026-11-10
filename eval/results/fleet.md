# Fleet: gate on and off

Each swarm gets three independent problems in one repository, one worker per problem. After the swarm, each problem's own verify command runs on the integration branch. A merged task counts as still failing when its verify command fails on the merged result.

## Tasks with a real bug

| | Swarms | Tasks | Merged and verified | Merged but still failing (of merged) | Blocked | Failed or conflict | Attempts per task | Wall time per swarm |
|---|---|---|---|---|---|---|---|---|
| Gate on | 18 | 45 | 12/45 (27%, 16%-41%) | 21/33 (64%, 47%-78%) | 0 | 12 | 1.56 | 4.3 min |
| Gate off | 18 | 45 | 9/45 (20%, 11%-34%) | 15/24 (63%, 43%-79%) | 0 | 21 | 1.00 | 2.2 min |

## Control tasks (already green, nothing to fix)

| | Swarms | Tasks | Merged and verified | Merged but still failing (of merged) | Blocked | Failed or conflict | Attempts per task | Wall time per swarm |
|---|---|---|---|---|---|---|---|---|
| Gate on | 18 | 9 | 7/9 (78%, 45%-94%) | 0/7 (0%, 0%-35%) | 0 | 2 | 1.67 | 4.3 min |
| Gate off | 18 | 9 | 3/9 (33%, 12%-65%) | 0/3 (0%, 0%-56%) | 0 | 6 | 1.00 | 2.2 min |

Intervals are 95% Wilson intervals over tasks. Wall time is per swarm and covers all three tasks.
