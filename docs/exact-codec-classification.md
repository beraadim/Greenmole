# Exact codec classification with early termination

The image-format selector retains its existing eligibility rules, PNG
repetition threshold, WebP-over-JPEG preference, lossy quality calculation,
lossless requirement, image geometry and instruction/frame ordering. This
change only reduces the pixel comparisons needed to determine that preference.

`LFR_guac_display_layer_prefers_png()` in `display-worker.c` examines adjacent
RGB pixels within each row. Each row starts independently; alpha and RGB24's
unused high byte are ignored, as before. Let `S` count equal adjacent pairs and
`D` count different pairs, with the historical bias `D = 1` before scanning.
The old nonnegative score was:

```
floor(256 * S / D) - 1024 >= 0
```

Its exact decision is `S >= 4 * D`. If `R` comparisons remain, the two extreme
completions provide safe early decisions:

- PNG is certain if `floor(S / 4) >= D + R`: even every remaining pair being
  different cannot change the decision.
- PNG is impossible if `floor((S + R) / 4) < D`: even every remaining pair being
  equal cannot change the decision.

The bounds are evaluated once per completed row, not per pixel. They never
guess from a sample, skip a dependent update, or reuse a previous frame's
classification. Ambiguous prefixes continue scanning; adversarial late pixel
changes retain the complete-scan decision. A one-row image still scans its
whole row. In a 100-row all-different fixture, the result is certain after
20 rows; a corresponding all-equal fixture needs 81 rows due to the initial
different-count bias. These structural reductions are not frame-speed claims.

Counters use `uint64_t`. The total horizontal-comparison count and its extra
bias are checked as `size_t` before obtaining the source pointer. Thus neither
`D + R` nor `S + R` can overflow, and division by four avoids scaled-count
overflow. The old signed `256 * S` expression overflowed above 8,388,607 equal
pairs, within supported display dimensions; the selector now follows the
mathematical threshold for such large regions as well. There is no meaningful
compatibility promise for the old expression's undefined signed-overflow result.

Empty rectangles retain their PNG preference. A one-pixel-wide nonempty region
has no horizontal comparisons and retains its non-PNG content preference;
normal format-eligibility rules may still require PNG. Neither case needs a
pixel read. Source traversal supports nonzero-origin rectangles and padded
rows, and does not advance past the final row. The display backing-state stride
is an unsigned `size_t`; a negative Cairo stride is not representable by this
internal API and is not newly introduced here. No source pixel or padding is
written. No memory is allocated or retained by the classifier.

## Validation and performance gate

The image-format tests compare the production decision with a separate full
scan using widened arithmetic for the original score. They cover 420 fixtures
around each exact threshold (including one-count differences), early/late/spread
equal pairs, independent row starts, varying alpha/high bytes, small/odd widths,
empty/reversed rectangles, one-column regions, a padded bottom-reaching
subrectangle, source immutability and the old large-region arithmetic overflow.
Existing codec eligibility tests exercise the actual public selector and an
instrumented source copy. A compile-time, test-only row hook counts comparisons
in that copy; production builds have no counter, callback, logging or per-pixel
instrumentation.

Run the normal configured native gate with `make check`, including WebP-enabled
and WebP-disabled configurations where available. For performance, compare the
exact old/new libraries in automatic codec mode with matched workloads and
alternating version order. Check frame CPU, p50/p95, realized codec/quality,
image count, pixel area, encoded bytes and independent pixel replay. Collect
classification timing separately with optional render diagnostics, keeping
instrumentation consistent. Fixed-PNG/WebP benchmark modes bypass the real
selector and cannot measure this scan or establish its benefit. Extra row
checks may cost more for tiny or near-threshold images, so retain those controls.
