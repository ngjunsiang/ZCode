# Main loop results (2026-10-14, Xvfb-isolated dev app, real 18-project sidebar)

B1: 12 warm switches; blocked = main-thread longtask ms within 3s of click. "engaged" = switches where a longtask was observed (timeout sampling differs per run; medians across runs are NOT comparable — see README caveats).
B2: one real 15s streaming task in /tmp/zcode-bench-ws. B3: cold revisit (agents were never cold here — see README).

| config | B1 blocked med(engaged) | B1 max | B2 blocked ms | B2 longtasks | B2 listTaskList | B3 revisit ms | git.refresh n | spawns |
|---|---|---|---|---|---|---|---|---|
| baseline2 | 662 | 977 | 4505 | 26 | 1 | 748 | 5 | 6 |
| opt1 | 448 | 840 | 3256 | 16 | 1 | 876 | 5 | 7 |
| opt2 | 596 | 948 | 4273 | 26 | 1 | 673 | 5 | 6 |
| opt3 | 440 | 648 | 4090 | 21 | 1 | 779 | 5 | 6 |
| opt4 | 701 | 972 | 4743 | 24 | 1 | 734 | 5 | 6 |
| opt5 | 410 | 689 | 4728 | 26 | 1 | 847 | 5 | 6 |

## Cold-visit runs (opt 4 focus)

| config | target | prewarm read before click | first read @ hover+ | ready @ hover+ | dwell |
|---|---|---|---|---|---|
| cold-baseline | parade-state | True | -127ms | 2654ms | 1182ms |
| cold-baseline | memogarden | True | -17ms | 2870ms | 1094ms |
| cold-opt4 | parade-state | True | 299ms | 2745ms | 1182ms |
| cold-opt4 | laymanswiki | True | 199ms | 2316ms | 1060ms |

Line-verified traces (authoritative for opt4, see README): baseline cold click pays readPresentation serially post-click = 2.35s (spawn+handshake); with opt4 the same work runs during the 1s hover and the click-time read is ~33ms (cached).
