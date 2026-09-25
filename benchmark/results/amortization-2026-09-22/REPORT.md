# Amortization: learned HTTP replay vs a browser every time

> **Regenerated after review (2026-09-22).** This first run's B wall times include an
> accessibility-snapshot read taken for a token count that the review found not comparable;
> the token rows were dropped. The re-run after the learn fix, with that instrumentation
> removed from B, is in `../amortization-2026-09-22b/`.

Run: 2026-09-22T22:33:18.755Z. Repetitions per task: 20, arms alternated, 1000ms between runs.

Arm A is Fastweb: learn + teach once (browser), then `run` over the compiled recipe.
Arm B runs the same taught plan in a fresh browser every time. B has no LLM
latency or tokens, so it is a **lower bound** on a browser agent, not an agent.
Wall times are in-process around each call; Node startup is excluded for both.
"Agreement" is Jaccard overlap of A and B items in the same repetition — the
page changes between the two reads, so this is consistency, **not correctness**.

## hn

First-time cost (A only): learn 3.5s + teach 2.0s = **5.5s**, 2 browser launch(es), 12 requests. Recipe: http-html.
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms, median (min–max) | 23115 (691–29097) | 2384 (1912–2757) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 6 |
| bytes downloaded, median | 40737 | 53861 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| politeness wait ms, median | 22587 | 0 (not applied) |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 6.2s | 58.1s | 109.6s | 234.5s | 490.8s | 2432.1s |
| A, selectors already known (teach only) | 2.7s | 54.5s | 106.1s | 230.9s | 487.3s | 2428.5s |
| A without politeness waits | 6.2s | 7.0s | 7.7s | 9.5s | 12.8s | 41.8s |
| B | 1.9s | 6.4s | 11.0s | 22.5s | 46.0s | 230.0s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**No break-even.** B's mean per-run wall time is not above A's, so A never catches up on time here.
With selectors already known (teach only), there is still no break-even within the observed repetitions.

## remoteok

First-time cost (A only): learn 205.4s + teach 12.9s = **218.3s**, 3 browser launch(es), 152 requests. Recipe: http-html.
Counting preparation, A launched 3 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms, median (min–max) | 581 (425–760) | 3690 (3532–4114) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 48 |
| bytes downloaded, median | 1118606 | 2145897 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| politeness wait ms, median | 0 | 0 (not applied) |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 218.9s | 220.1s | 221.3s | 224.3s | 229.7s | 275.2s |
| A, selectors already known (teach only) | 13.5s | 14.8s | 15.9s | 18.9s | 24.3s | 69.8s |
| A without politeness waits | 218.9s | 220.1s | 221.3s | 224.3s | 229.7s | 275.2s |
| B | 3.6s | 11.3s | 18.7s | 37.4s | 74.1s | 370.3s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**No break-even within 20 repetitions when the page is investigated first.** Extrapolating from mean per-run costs it would come at about repetition 70; that is an extrapolation, not an observation.
With selectors already known (teach only), break-even is at repetition 5, still holding at repetition 20.

## steam

First-time cost (A only): learn 25.9s + teach 3.7s = **29.6s**, 2 browser launch(es), 420 requests. Recipe: http-html.
Counting preparation, A launched 2 browser(s) in total; B launched 20. "Zero browser launches" holds for the replays only.

| per repetition | A (Fastweb) | B (browser each time) |
| --- | ---: | ---: |
| wall ms, median (min–max) | 436 (235–875) | 3427 (2856–3957) |
| browser launches, total | 0 | 20 |
| network requests, median | 1 | 205 |
| bytes downloaded, median | 161915 | 22746685 |
| runs with items / total | 20/20 | 20/20 |
| A fell back to a browser | 0 | — |
| politeness wait ms, median | 0 | 0 (not applied) |
| A–B agreement, median (min) | 1.00 (1.00) | |

| cumulative wall time | k=1 | k=3 | k=5 | k=10 | k=20 | k=100 (extrapolated from means) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, page investigated first (learn + teach) | 30.4s | 31.2s | 31.9s | 34.0s | 38.1s | 72.2s |
| A, selectors already known (teach only) | 4.6s | 5.3s | 6.0s | 8.2s | 12.2s | 46.4s |
| A without politeness waits | 30.4s | 31.2s | 31.9s | 34.0s | 38.1s | 72.2s |
| B | 3.2s | 9.1s | 14.8s | 32.9s | 68.0s | 340.0s |

Repetitions without items: A none; B none. A repetition without items is a page the site did not serve as taught; both arms pay for it, A also pays its browser fallback.
**Break-even observed at repetition 11** when the page is investigated first (learn + teach counted), and A is still below B at repetition 20.
With selectors already known (teach only), break-even is at repetition 2, still holding at repetition 20.

## What this does not show

- B is a scripted browser with the answer selectors already known. A real browser agent adds LLM calls and reasoning latency per step; its line would be higher. Neither arm's LLM usage was measured.
- Tokens are not compared: both arms extract the same fields, so an agent would read the same output from either. An earlier draft compared A's TSV against B's whole-page accessibility snapshot; that only showed that selected fields are smaller than a page.
- `learn` runs here but its output is not used: `teach` receives selectors chosen in advance. The "investigated first" row charges learn anyway; the "selectors already known" row is the same records minus learn time, an arithmetic split, not a second experiment.
- Agreement is consistency between two reads of a changing page, not an independent correctness check.
- Three sites, one session, one machine and network. Per-site tables are the result; there is no pooled average.
- The first-time cost is what a person pays once per task; it does not include the person's own time choosing selectors.
- Politeness waits (per-host spacing and robots `Crawl-delay`) are applied only to A's HTTP requests. B's browser makes no such promise. On a host with a long Crawl-delay this dominates A's wall time by policy, not by speed.
