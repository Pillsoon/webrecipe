# Benchmarks

The harness and the results behind the numbers in the top-level README.

These reports were written while the tool was called `fastweb` and its commands
were `learn`, `teach`, and `run`. They are kept as they were: today's `inspect`,
`save`, and `fetch` are the same code paths under new names.

| What | Where |
| --- | --- |
| HTTP replay vs. a browser every time, 20 repetitions per site, with first-time cost and break-even | `results/amortization-2026-09-22d/REPORT.md` (`amortization.ts`) |
| Real-site batch: 8 domains, 79 inputs, verifier verdicts judged by hand against each site's own API | `results/discovery-2026-09-21-v2/README.md` |
| The earlier run of the same batch whose oracle was wrong, kept for what it got wrong | `results/discovery-2026-09-21-v1/README.md` |
| A site that saved cleanly one day and refused the next | `results/drift/` |
| Controlled fixtures (30 tasks) and wild sites (30 tasks), success and latency | `results/final.txt`, `results/wild-per-site.txt` |
| Task-cost instrumentation before and after the measurement boundary was fixed | `results/2026-09-20-task-cost-{before,after}.json` |

Run the benchmark yourself:

```sh
pnpm exec tsx src/cli.ts bench run
```

The controlled half runs against local fixtures and needs nothing else. The
wild half compares against goldens captured from live sites, which are not
committed, so it reports "no stored golden" until you run
`bench capture` first (that opens a browser on each site).

Goldens and recipes captured from live sites are not committed: they go stale
within hours, and a stale one describes a page nobody can see again.
