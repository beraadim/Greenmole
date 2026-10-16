# Display planner scratch and copy search

The planner keeps one lazily allocated plan per display, including its 65,536
hash buckets, an 8 KiB occupied-bucket bitmap, a list of touched buckets, and up
to 4,096 operation entries.
Operation capacity grows geometrically from 64 entries. A 4K desktop fits in
that operation bound before combining its 64×64 cells. The retained storage is
`sizeof(guac_display_plan) + capacity * sizeof(guac_display_plan_operation)`;
it is bounded independently of the largest frame ever received.

Plans above 4,096 operations use transient storage, as do nested requests while
the cached plan is owned by another caller. They do not grow or replace the
cache. The index is zeroed when allocated and subsequently clears only buckets
that were written by the preceding plan. Consumed entries remain on the touched
list, so they are also cleared. Hash values with a null operation are never
used for lookup. No layer, pixel, or operation pointer can survive into the next
plan's index.

Plan acquisition, optimization, application, and release run under the pending
frame write lock. The worker FIFO receives operation values, so encoding does
not retain pointers into the scratch array. Per-cell references are assigned or
cleared for all pending cells before combining a newly created plan. Refresh
uses the committed-frame path and does not borrow planner scratch. Stopping the
display invalidates the FIFO but retains scratch until display destruction:
protocol producers may still be finishing when workers stop. As with the layer
buffers and locks, callers must finish those producers before freeing a display.
A late flush observes the invalid FIFO before constructing a new plan.

Allocation failure aborts the session with a server error and does not commit an
incomplete plan. Existing cached storage remains valid if growing its operation
array fails. There are no additional protocol fields, environment settings, or
connection parameters.

## Copy-search boundaries

Only the first operation accepted into each hash bucket is a candidate. A
bucket collision or duplicate does not increase the candidate count. A different
full 64-bit hash cannot remove the entry. A matching full hash consumes the
candidate, and the existing full pixel comparison still decides whether the
operation can become a copy. A pixel mismatch keeps the image operation and
bans that candidate, preserving the previous collision behavior.

An exact bitmap rejects empty hash buckets before reading the larger operation
index. An accepted insertion sets its bucket bit; consuming that full-hash
candidate clears it. A different full hash in the same bucket preserves the
bit and candidate. Pixel mismatches still consume and ban their candidate.
Touched-bucket reset clears both the operation pointer and membership bit,
including entries already consumed. Cached, nested and oversized plans each own
their bitmap, with the same allocation and destruction lifetime as their index.
The bitmap adds exactly 8,192 bytes to each plan, including the retained-scratch
gauge. It does not alter candidate counts, scan order, hash comparisons, exact
pixel checks, copy choices, encoded bytes or frame boundaries.

Indexing computes each complete 64×64 cell's hash directly with row and cell
accumulators. It uses the same unsigned 64-bit polynomial as the final window of
the rolling search, without allocating or clearing that search's full-width
hash array for every indexed cell. The rolling walker is used only for search
and calls the typed copy lookup directly, without a callback dispatch.

A frame with no indexed candidates skips rolling copy search. After the last
candidate is consumed, search finishes the current row and stops before later
rows or layers because no later window could rewrite another operation. This
permits at most the remainder of one row of redundant hashing and keeps the
candidate-count check out of the per-window loop. Misses still examine the
complete original search region.
The hash values, scan order, exact collision checks, image fallback, operation
combining, codec policy, frame markers, and worker admission policy are unchanged.

## Validation and private diagnostics

Native tests exercise bucket collisions and duplicates, exact-pixel mismatches,
hits, misses, empty searches, exhaustion, repeated index reuse across changing
frame dimensions, simultaneous transient plans, the 4,096/4,097 boundary,
retained-storage cleanup, stopped queues, and the locked diagnostic getter.
Isolated allocation-failure tests verify session abort, unchanged cached storage
after failed growth, and release of every partially allocated object.
Hash tests use an independent weighted-sum reference for zero, white, maximum,
high-bit, sparse, random, repeated-row and repeated-column pixels. Copy tests
match fixed-cell index hashes to rolling search at nonzero source/destination
offsets with unequal padded strides.
Bitmap tests cover word boundaries and high bits, all 65,536 occupied buckets,
partial consumption and full reset, hash collisions, pixel-mismatch consumption,
cached reuse across resizes, simultaneous transient plans, and oversized plans.

## Row hashing and warm-up regions

The unsigned polynomial uses base 62, with arithmetic modulo 2^64. Four
independent Horner chains at base `62^4 = 14,776,336` hash the 63-pixel row
prefixes and complete 64-pixel index rows. Combining those chains in their
original pixel order, then appending any remaining pixels, produces exactly
the original polynomial. This reduces the dependent arithmetic chain without
introducing architecture-specific vector instructions or changing pixel bits.

The rolling search handles its first 63 rows separately because they cannot
produce a complete window. Each row first hashes its 63-pixel prefix, then
updates only the vertical accumulators that can become complete windows.
The first 63 columns therefore need no vertical storage or updates. Subsequent
rows visit every complete window directly, with no per-pixel warm-up checks.
Their lookup order remains top to bottom, left to right. A consumed last
candidate still finishes the same row, preserving the examined-window counts.

The stack allocation retains its existing maximum width bound; only the
`width - 63` active accumulators are cleared. No pixel buffer, operation index,
candidate bit, or admission state is cached differently. Fixed-cell hashing,
rolling search and exact pixel comparison avoid advancing a row pointer after
their final access, including bottom-reaching views with nonzero left offsets
and padded strides.

Additional tests independently evaluate 414 weighted row hashes, exercise all
441 window positions across 64-through-69-pixel region dimensions, and check
the maximum 8,192-pixel width, padded bottom-reaching views, unreadable
incomplete regions, row-major duplicate selection, and full-hash collisions
that must consume a candidate before a later exact match. The isolated local
hash microbenchmark is useful for checking dependency reductions, but complete
planning/encoding benchmarks on the deployment platform are still required
before making end-to-end performance claims.

The private `guac_display_get_planner_statistics()` entrypoint accepts exactly ten
`uint64_t` values and acquires the pending-frame read lock. It exposes numeric
work and allocation counts, never pixels, hashes, layer identifiers, or pointers.
Slots 0–8 are cumulative for the display; slot 9 is a current-memory gauge:

| Slot | Value |
| --- | --- |
| 0 | Successful plan-object allocations, cached or transient |
| 1 | Reuses of the cached plan |
| 2 | Operation-array allocations or growth |
| 3 | Touched hash buckets cleared |
| 4 | Candidates actually inserted into the index |
| 5 | Complete 64×64 search windows examined |
| 6 | Exact copy matches |
| 7 | Copy-search passes skipped because the index was empty |
| 8 | Copy-search passes ended when candidates were exhausted |
| 9 | Bytes currently retained for planner scratch |

The production benchmark resolves this symbol dynamically, reports deltas over
measured frames, and treats its absence in older releases as unavailable. It
compares complete planning/FIFO/encoding frame costs, retained work counts, and
separate lossless protocol replay. The structural reductions do not establish a
particular latency improvement: representative benchmarks, repeated in both
orders against private.6, are needed before making a performance claim.
The bitmap additionally requires comparison against an otherwise identical
optimized private.7 baseline: avoiding operation-index reads may save cache
traffic, but the membership test itself adds per-window work. Native tests and
lossless replay establish correctness; they do not establish a throughput gain.
