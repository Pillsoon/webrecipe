# openlibrary.org /trending — learnable on 2026-09-21, not on 2026-09-22

Kept for Step 6. Nothing here is fixed; the point is that the before and the
after both survive.

## before — v1, 2026-09-21T23:10Z

Taught from `https://openlibrary.org/trending/now?page=1` and learned cleanly.
Full evidence in `../discovery-2026-09-21-v1/evidence/openlibrary.org-list.json`.

    urlTemplate   /trending/{{query}}?page={{page}}
    itemSelector  li.searchResultItem
    fields        title  h3.booktitle a.results
                  url    h3.booktitle a.results@href
                  author span.bookauthor a

    contract      non_empty, required_fields, pagination_honored
    pagination_honored  passed
      taught page 1 -> 20 items, repeat -> 20, alternate page 2 -> 20
      stable, moved, agreed; overlap 0.05

Five inputs ran; all five came back `verified`.

## after — v2, 2026-09-22T14:40Z

    teach_failed: Selected fields are missing: author.
                  Inspect the samples and teach again.

The task was skipped, so openlibrary.org contributed no list records to v2.

## what was measured on 2026-09-22, and what was not

Three requests from this machine, browser user agent, following redirects:

    200  https://openlibrary.org/trending/now?page=1   verify_human interstitial, no searchResultItem, no bookauthor
    200  https://openlibrary.org/search?q=dale+carnegie   61x searchResultItem, 20x bookauthor
    200  https://openlibrary.org/works/OL1063267W      verify_human interstitial

So the markup the plan reads still exists on `/search`, and `/trending` and
`/works` answered with a human-verification interstitial carried on a 200.

That is an observation about this machine at this hour, not a diagnosis of the
teach failure. The failing run reported a missing `author` among samples that
were found, which an interstitial with no `li.searchResultItem` would not
produce — it would have failed on the item selector instead. Two different
states of the origin are on the record and neither was shown to cause the
other.

## why it is worth keeping

An origin that refuses with a 200 and a page of its own chrome is the same
shape as the Jira login page: a wall an extractor can mistake for content.
Here it failed loudly, and only because the selectors were specific enough to
match nothing. `non_empty` and `required_fields` are the whole of the defence.
