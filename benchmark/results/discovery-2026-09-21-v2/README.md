# discovery v2 — the real-site batch the frozen verifier was measured on

baseline `7f51ca0`, 8 domains, 17 learned tasks, 79 evaluated inputs, nothing
cached. The verifier was not modified between v1 and v2; every difference
between the two is measurement. v1 is kept beside this one for what its oracle
got wrong.

## automatic

                     correct   wrong   indeterminate
  verified                11       0              23
  partially_verified       0       0              39
  unverified               1       0               0
  error                    0       0               5

## manual, queue A

All 23 `verified + indeterminate` records were judged by hand from
`manual-queue-a.jsonl`, blind: site, intent, input, url template, extracted
fields and the returned items were read first, and the verification status
only after a judgement was written down.

  correct 20   wrong 0   indeterminate 3

Every judgement was settled against the site's own JSON API — dev.to
`/api/articles`, lemmy `/api/v3/post`, discourse `/t/{id}.json` and the tag
listings, openlibrary `/works/{id}.json`, hex `/api/packages/{name}` — which is
neither the HTML the recipe reads nor anything the verifier consulted. For the
lists this is a precision check: every returned row carries the tag that was
asked for. It says nothing about completeness or ordering.

No false success was found. That is a claim about 32 soundly judged answers,
not about the batch.

## what queue A actually exposed

Twelve of the 23 reached `verified` on a contract of `non_empty` plus
`required_fields` and nothing else. Every detail lookup here is in that group.
The eleven detail answers are right, and the verifier is not what established
it — a detail plan currently carries no check that the entity it returned is
the entity that was asked for.

`discourse-detail-1` is where that gap shows. The answer's title and url are
exact; its `category` reads "Contribute" while the topic sits in "Feature",
because meta.discourse.org breadcrumbs `Contribute > Feature` and
`span.category-name` matches the ancestor first. It is left indeterminate
rather than wrong: nothing declared whether the field means the category or
the path to it. It is the shape a false success would take, in the exact place
the contract requires nothing.
