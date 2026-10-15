# Display planner scratch and copy search

The planner keeps one lazily allocated plan per display, including its 65,536
hash buckets, a list of touched buckets, and up to 4,096 operation entries.
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

A frame with no indexed candidates skips rolling copy search. After the last
candidate is consumed, search finishes the current row and stops before later
rows or layers because no later window could rewrite another operation. This
permits at most the remainder of one row of redundant hashing and keeps the
candidate-count check out of the per-window loop. Misses still examine the
complete original search region.
The rolling hash, scan order, exact collision checks, image fallback, operation
combining, codec policy, frame markers, and worker admission policy are unchanged.

## Validation and private diagnostics

Native tests exercise bucket collisions and duplicates, exact-pixel mismatches,
hits, misses, empty searches, exhaustion, repeated index reuse across changing
frame dimensions, simultaneous transient plans, the 4,096/4,097 boundary,
retained-storage cleanup, stopped queues, and the locked diagnostic getter.
Isolated allocation-failure tests verify session abort, unchanged cached storage
after failed growth, and release of every partially allocated object.

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
