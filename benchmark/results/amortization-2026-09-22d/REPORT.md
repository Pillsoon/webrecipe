# Amortization: learned HTTP replay vs a browser every time

Run: 2026-09-22T23:51:11.031Z. Repetitions per task: 20, arms alternated, 1000ms between runs.

Arm A is Fastweb: learn + teach once (browser), then `run` over the compiled recipe.
Arm B runs the same taught plan in a fresh browser every time. B has no LLM
latency or tokens, so it is a **lower bound** on a browser agent, not an agent.
Wall times are in-process around each call; Node startup is excluded for both.
"Agreement" is Jaccard overlap of A and B items in the same repetition — the
page changes between the two reads, so this is consistency, **not correctness**.

## hn

First-time cost (A only): learn 2.7s + teach 2.7s = **5.4s**, 2 browser launch(es), 12 requests. Recipe: http-html.
learn split: page load 2.4s, candidate generation ~0.1s, field candidates ~0.2s (41 KB HTML; the split re-times candidate generation on the same HTML). Gate waits before learn/teach: 0/27231 ms.
Access policy: one page load per 30000 ms on this host, applied to learn, teach and every repetition of both arms (teach's probe requests follow A's own politeness layer).
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms incl. waits, median (min–max) | 27982 (27426–30498) | 31660 (29355–32956) |
| processing ms (wall − waits), median (min–max) | 402 (221–823) | 2622 (2431–3260) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 6 |
| bytes downloaded, median | 40613 | 53758 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| gate wait ms, median | 27571 | 29164 |
| A's own politeness wait ms, median | 0 | — |
| A–B agreement, median (min) | 1.00 (0.94) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 33.4s | 91.3s | 148.8s | 292.5s | 580.9s | 2882.8s |
| A, selectors already known (teach only) | 30.7s | 88.6s | 146.1s | 289.8s | 578.2s | 2880.1s |
| A, processing only (no waits) | 6.1s | 6.9s | 7.7s | 9.9s | 13.6s | 46.4s |
| B | 32.1s | 93.8s | 156.4s | 310.5s | 621.7s | 3108.3s |
| B, processing only (no waits) | 2.8s | 7.7s | 13.2s | 26.1s | 53.1s | 265.6s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**Break-even observed at repetition 2** when the page is investigated first (learn + teach counted), and A is still below B at repetition 20.
With selectors already known (teach only), break-even is at repetition 1, still holding at repetition 20.

## remoteok

First-time cost (A only): learn 39.6s + teach 12.7s = **52.3s**, 3 browser launch(es), 153 requests. Recipe: http-html.
learn split: page load 6.0s, candidate generation ~7.2s, field candidates ~26.4s (1152 KB HTML; the split re-times candidate generation on the same HTML). Gate waits before learn/teach: 0/0 ms.
Access policy: one page load per 1000 ms on this host, applied to learn, teach and every repetition of both arms (teach's probe requests follow A's own politeness layer).
Counting preparation, A launched 3 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms incl. waits, median (min–max) | 661 (554–914) | 3847 (3199–4313) |
| processing ms (wall − waits), median (min–max) | 561 (423–842) | 3411 (3199–3774) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 48 |
| bytes downloaded, median | 1118606 | 2082230 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| gate wait ms, median | 0 | 408 |
| A's own politeness wait ms, median | 0 | — |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 52.9s | 54.3s | 55.7s | 59.2s | 66.5s | 123.0s |
| A, selectors already known (teach only) | 13.3s | 14.7s | 16.1s | 19.6s | 26.8s | 83.4s |
| A, processing only (no waits) | 52.9s | 53.9s | 54.9s | 57.7s | 63.4s | 107.7s |
| B | 4.1s | 11.4s | 18.9s | 37.1s | 74.3s | 371.7s |
| B, processing only (no waits) | 3.7s | 10.5s | 17.4s | 34.6s | 69.1s | 345.6s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**Break-even observed at repetition 18** when the page is investigated first (learn + teach counted), and A is still below B at repetition 20.
With selectors already known (teach only), break-even is at repetition 5, still holding at repetition 20.

## steam

First-time cost (A only): learn 12.0s + teach 2.8s = **14.8s**, 2 browser launch(es), 424 requests. Recipe: http-html.
learn split: page load 4.0s, candidate generation ~0.3s, field candidates ~7.7s (316 KB HTML; the split re-times candidate generation on the same HTML). Gate waits before learn/teach: 0/0 ms.
Access policy: one page load per 1000 ms on this host, applied to learn, teach and every repetition of both arms (teach's probe requests follow A's own politeness layer).
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms incl. waits, median (min–max) | 645 (283–927) | 3082 (2681–3932) |
| processing ms (wall − waits), median (min–max) | 302 (164–792) | 2864 (2681–3246) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 212 |
| bytes downloaded, median | 161921 | 33550248 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| gate wait ms, median | 0 | 206 |
| A's own politeness wait ms, median | 0 | — |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 15.6s | 16.8s | 18.0s | 20.7s | 26.8s | 74.7s |
| A, selectors already known (teach only) | 3.6s | 4.8s | 6.0s | 8.7s | 14.8s | 62.7s |
| A, processing only (no waits) | 15.6s | 16.1s | 16.8s | 18.3s | 21.3s | 47.5s |
| B | 3.1s | 9.6s | 16.1s | 31.7s | 64.7s | 323.7s |
| B, processing only (no waits) | 2.9s | 8.6s | 14.4s | 28.5s | 57.7s | 288.4s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**Break-even observed at repetition 6** when the page is investigated first (learn + teach counted), and A is still below B at repetition 20.
With selectors already known (teach only), break-even is at repetition 2, still holding at repetition 20.

## What this does not show

- B is a "new browser each time, no LLM" control with the answer selectors already known. It is not a bound on every browser-based approach (a reused browser, for one, would be cheaper per run), and neither arm's LLM usage was measured.
- Tokens are not compared: both arms extract the same fields, so an agent would read the same output from either. An earlier draft compared A's TSV against B's whole-page accessibility snapshot; that only showed that selected fields are smaller than a page.
- `learn` runs here but its output is not used: `teach` receives selectors chosen in advance. The "investigated first" row charges learn anyway; the "selectors already known" row is the same records minus learn time, an arithmetic split, not a second experiment.
- Agreement is consistency between two reads of a changing page, not an independent correctness check.
- Three sites, one session, one machine and network. Per-site tables are the result; there is no pooled average.
- The first-time cost is what a person pays once per task; it does not include the person's own time choosing selectors.
- Where the access policy line above says it applied to both arms, wall time includes the same per-host gate for A and B; "processing only" rows remove gate and politeness waits. Older runs without that line gated only A and are kept as policy-asymmetric experiments, not re-labelled.
