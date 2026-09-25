# discovery v1 — the run that showed the oracle needed a gate

baseline `7f51ca0`, 8 domains, 17 learned tasks, 84 evaluated inputs.

Kept because of what it got wrong, not what it measured.

It reported ten `verified + wrong` results, every one of them on a detail
lookup at lemmy.world or dev.to. None was a false success. The oracle asked
whether the requested id appeared among the fields the answer carried, and
never asked whether the plan extracted a field that could carry one. dev.to's
plan takes a title and an author; lemmy's `url` is the outbound link a post
points at, not the post. The answers were right and the rule could not see it.

Two things follow, and both are fixed in v2:

- An oracle needs an applicability gate as much as a verifier does. Whether a
  rule can be applied here is a separate question from what it concludes, and
  it has to be asked first and recorded.
- Only the row count was kept per evaluated input, so a corrected oracle could
  not be run over this data. Re-judging meant hitting eight origins again.

The verifier was not changed between v1 and v2. Any difference is measurement.
