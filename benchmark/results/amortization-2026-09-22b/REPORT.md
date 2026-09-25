# Amortization: learned HTTP replay vs a browser every time

Run: 2026-09-22T22:33:20.620Z. Repetitions per task: 20, arms alternated, 1000ms between runs.

Arm A is Fastweb: learn + teach once (browser), then `run` over the compiled recipe.
Arm B runs the same taught plan in a fresh browser every time. B has no LLM
latency or tokens, so it is a **lower bound** on a browser agent, not an agent.
Wall times are in-process around each call; Node startup is excluded for both.
"Agreement" is Jaccard overlap of A and B items in the same repetition — the
page changes between the two reads, so this is consistency, **not correctness**.

## hn

First-time cost (A only): learn 2.8s + teach 2.0s = **4.8s**, 2 browser launch(es), 12 requests. Recipe: http-html.
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms, median (min–max) | 22879 (739–29199) | 2366 (1921–3494) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 6 |
| bytes downloaded, median | 40785 | 53909 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| politeness wait ms, median | 22575 | 0 (not applied) |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 5.6s | 55.9s | 107.0s | 232.5s | 488.1s | 2421.3s |
| A, selectors already known (teach only) | 2.7s | 53.1s | 104.2s | 229.6s | 485.3s | 2418.5s |
| A without politeness waits | 5.6s | 6.3s | 7.5s | 8.9s | 11.9s | 40.4s |
| B | 3.1s | 8.3s | 12.7s | 23.7s | 47.7s | 238.6s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**No break-even.** B's mean per-run wall time is not above A's, so A never catches up on time here.
With selectors already known (teach only), break-even is at repetition 1, but A is above B again at repetition 20.

## remoteok

First-time cost (A only): learn 76.1s + teach 12.7s = **88.8s**, 3 browser launch(es), 153 requests. Recipe: http-html.
Counting preparation, A launched 3 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms, median (min–max) | 590 (421–872) | 3542 (3373–3808) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 48 |
| bytes downloaded, median | 1118606 | 2051183 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| politeness wait ms, median | 0 | 0 (not applied) |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 89.4s | 90.4s | 91.8s | 94.7s | 100.0s | 145.0s |
| A, selectors already known (teach only) | 13.3s | 14.4s | 15.7s | 18.6s | 23.9s | 68.9s |
| A without politeness waits | 89.4s | 90.4s | 91.8s | 94.7s | 100.0s | 145.0s |
| B | 3.5s | 10.6s | 17.9s | 35.8s | 71.4s | 356.9s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**No break-even within 20 repetitions when the page is investigated first.** Extrapolating from mean per-run costs it would come at about repetition 30; that is an extrapolation, not an observation.
With selectors already known (teach only), break-even is at repetition 5, still holding at repetition 20.

## steam

First-time cost (A only): learn 17.2s + teach 3.9s = **21.1s**, 2 browser launch(es), 415 requests. Recipe: http-html.
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms, median (min–max) | 580 (159–30484) | 3969 (3186–11810) |
| browser launches, total | 2 | 20 |
| network requests, median | 1 | 187 |
| bytes downloaded, median | 137801 | 15722558 |
| runs with items / total | 15/20 | 16/20 |
| A fell back to a browser | 5 | — |
| politeness wait ms, median | 0 | 0 (not applied) |
| A–B agreement, median (min) | 1.00 (0.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 21.6s | 22.2s | 23.1s | 25.3s | 125.5s | 542.9s |
| A, selectors already known (teach only) | 4.5s | 5.1s | 5.9s | 8.2s | 108.3s | 525.7s |
| A without politeness waits | 21.6s | 22.2s | 23.1s | 25.3s | 125.5s | 542.9s |
| B | 3.3s | 10.5s | 17.1s | 35.9s | 107.7s | 538.4s |

Repetitions without items: A 16, 17, 18, 19, 20; B 17, 18, 19, 20. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**Break-even observed at repetition 8** when the page is investigated first (learn + teach counted), but A is above B again at repetition 20.
With selectors already known (teach only), break-even is at repetition 2, but A is above B again at repetition 20.

## What this does not show

- B is a scripted browser with the answer selectors already known. A real browser agent adds LLM calls and reasoning latency per step; its line would be higher. Neither arm's LLM usage was measured.
- Tokens are not compared: both arms extract the same fields, so an agent would read the same output from either. An earlier draft compared A's TSV against B's whole-page accessibility snapshot; that only showed that selected fields are smaller than a page.
- `learn` runs here but its output is not used: `teach` receives selectors chosen in advance. The "investigated first" row charges learn anyway; the "selectors already known" row is the same records minus learn time, an arithmetic split, not a second experiment.
- Agreement is consistency between two reads of a changing page, not an independent correctness check.
- Three sites, one session, one machine and network. Per-site tables are the result; there is no pooled average.
- The first-time cost is what a person pays once per task; it does not include the person's own time choosing selectors.
- Politeness waits (per-host spacing and robots `Crawl-delay`) are applied only to A's HTTP requests. B's browser makes no such promise. On a host with a long Crawl-delay this dominates A's wall time by policy, not by speed.
