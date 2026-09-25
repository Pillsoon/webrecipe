# Amortization: learned HTTP replay vs a browser every time

Run: 2026-09-22T23:23:43.802Z. Repetitions per task: 20, arms alternated, 1000ms between runs.

Arm A is Fastweb: learn + teach once (browser), then `run` over the compiled recipe.
Arm B runs the same taught plan in a fresh browser every time. B has no LLM
latency or tokens, so it is a **lower bound** on a browser agent, not an agent.
Wall times are in-process around each call; Node startup is excluded for both.
"Agreement" is Jaccard overlap of A and B items in the same repetition — the
page changes between the two reads, so this is consistency, **not correctness**.

## hn

First-time cost (A only): learn 3.5s + teach 2.0s = **5.4s**, 2 browser launch(es), 12 requests. Recipe: http-html.
learn phases not recorded in this run.
Access policy: none applied to B in this run (A honoured its own politeness layer); this run is a policy-asymmetric experiment.
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms incl. waits, median (min–max) | 23221 (516–29221) | 2393 (1904–3368) |
| processing ms (wall − waits), median (min–max) | 423 (251–609) | 2393 (1904–3368) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 6 |
| bytes downloaded, median | 40519 | 53643 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| gate wait ms, median | 0 | 0 |
| A's own politeness wait ms, median | 22798 | — |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 5.9s | 58.0s | 109.2s | 233.4s | 489.4s | 2425.2s |
| A, selectors already known (teach only) | 2.5s | 54.6s | 105.7s | 229.9s | 485.9s | 2421.7s |
| A, processing only (no waits) | 5.9s | 6.7s | 7.5s | 9.6s | 13.6s | 46.5s |
| B | 1.9s | 6.7s | 11.3s | 23.1s | 47.0s | 235.2s |
| B, processing only (no waits) | 1.9s | 6.7s | 11.3s | 23.1s | 47.0s | 235.2s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**No break-even.** B's mean per-run wall time is not above A's, so A never catches up on time here.
With selectors already known (teach only), there is still no break-even within the observed repetitions.

## remoteok

First-time cost (A only): learn 70.7s + teach 13.3s = **83.9s**, 3 browser launch(es), 152 requests. Recipe: http-html.
learn phases not recorded in this run.
Access policy: none applied to B in this run (A honoured its own politeness layer); this run is a policy-asymmetric experiment.
Counting preparation, A launched 3 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms incl. waits, median (min–max) | 701 (435–1312) | 3821 (3558–5639) |
| processing ms (wall − waits), median (min–max) | 701 (435–1312) | 3821 (3558–5639) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 48 |
| bytes downloaded, median | 1118606 | 2061584 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| gate wait ms, median | 0 | 0 |
| A's own politeness wait ms, median | 0 | — |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 84.7s | 85.8s | 87.1s | 91.6s | 97.7s | 153.0s |
| A, selectors already known (teach only) | 14.0s | 15.1s | 16.5s | 20.9s | 27.1s | 82.3s |
| A, processing only (no waits) | 84.7s | 85.8s | 87.1s | 91.6s | 97.7s | 153.0s |
| B | 3.8s | 11.1s | 19.1s | 40.2s | 80.0s | 400.2s |
| B, processing only (no waits) | 3.8s | 11.1s | 19.1s | 40.2s | 80.0s | 400.2s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**No break-even within 20 repetitions when the page is investigated first.** Extrapolating from mean per-run costs it would come at about repetition 26; that is an extrapolation, not an observation.
With selectors already known (teach only), break-even is at repetition 5, still holding at repetition 20.

## steam

First-time cost (A only): learn 20.9s + teach 3.6s = **24.4s**, 2 browser launch(es), 394 requests. Recipe: http-html.
learn phases not recorded in this run.
Access policy: none applied to B in this run (A honoured its own politeness layer); this run is a policy-asymmetric experiment.
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms incl. waits, median (min–max) | 423 (167–614) | 3212 (2881–4012) |
| processing ms (wall − waits), median (min–max) | 423 (167–614) | 3212 (2881–4012) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 212 |
| bytes downloaded, median | 161914 | 33555645 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| gate wait ms, median | 0 | 0 |
| A's own politeness wait ms, median | 0 | — |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 25.0s | 25.7s | 26.6s | 28.4s | 32.3s | 63.7s |
| A, selectors already known (teach only) | 4.2s | 4.8s | 5.7s | 7.5s | 11.4s | 42.8s |
| A, processing only (no waits) | 25.0s | 25.7s | 26.6s | 28.4s | 32.3s | 63.7s |
| B | 3.1s | 10.2s | 17.1s | 33.4s | 65.0s | 324.8s |
| B, processing only (no waits) | 3.1s | 10.2s | 17.1s | 33.4s | 65.0s | 324.8s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**Break-even observed at repetition 9** when the page is investigated first (learn + teach counted), and A is still below B at repetition 20.
With selectors already known (teach only), break-even is at repetition 2, still holding at repetition 20.

## What this does not show

- B is a "new browser each time, no LLM" control with the answer selectors already known. It is not a bound on every browser-based approach (a reused browser, for one, would be cheaper per run), and neither arm's LLM usage was measured.
- Tokens are not compared: both arms extract the same fields, so an agent would read the same output from either. An earlier draft compared A's TSV against B's whole-page accessibility snapshot; that only showed that selected fields are smaller than a page.
- `learn` runs here but its output is not used: `teach` receives selectors chosen in advance. The "investigated first" row charges learn anyway; the "selectors already known" row is the same records minus learn time, an arithmetic split, not a second experiment.
- Agreement is consistency between two reads of a changing page, not an independent correctness check.
- Three sites, one session, one machine and network. Per-site tables are the result; there is no pooled average.
- The first-time cost is what a person pays once per task; it does not include the person's own time choosing selectors.
- Where the access policy line above says it applied to both arms, wall time includes the same per-host gate for A and B; "processing only" rows remove gate and politeness waits. Older runs without that line gated only A and are kept as policy-asymmetric experiments, not re-labelled.
