# Indexed PNG palette preparation

RGB24 images with at most 256 colors retain the same lossless indexed PNG
format, palette order, bit depth, libpng defaults and encoded output. Palette
indices follow the first occurrence of each RGB color in row-major order.
Unused RGB24 high bytes remain ignored. ARGB32 and images exceeding 256 colors
retain the Cairo writer. This change does not alter codec selection or quality.

The writer now requests its palette and index rows together. Up to 4,096 index
bytes are initially held on the stack while the palette is built. High-color
images usually exceed the palette limit during that prefix and allocate no
whole-image index block. If the complete row table plus index bytes fit within
64 KiB, an eligible prefix is copied into the existing contiguous row block
and the remaining pixels are indexed during palette construction. Images that
fit entirely in the prefix need only the final copy of those index bytes.

Larger images keep palette preflight followed by index generation. This
intentional second source pass avoids speculatively allocating a potentially
large index buffer before discovering a late 257th color. The cap includes
the row pointers, so a very tall narrow image cannot evade it. All size
arithmetic is checked. There is no new retained worker or display allocation.

Failed speculative staging allocation is optional: palette preflight finishes
without indices. A high-color image can still use Cairo; an eligible palette
retries the ordinary final allocation and fills its indices. If that allocation
also fails, the writer returns an error with no partial output and no leaked
palette. Palette allocation failure retains the existing Cairo fallback.
Owned palette/row pointers are finalized before `setjmp()` and do not change
during libpng calls, preserving reliable cleanup after an output `longjmp()`.

The map mixes all RGB bits before choosing one of its 4,096 initial buckets.
Only a collision computes an odd secondary probe step; that step visits the
entire power-of-two table. With at most 256 occupied entries, a lookup examines
at most 257 buckets before finding its color or an empty slot. The previous
XOR of 12-bit halves clustered all 256 grayscale colors into 16 initial buckets.
Consecutive equal colors reuse the preceding index, including runs crossing
row boundaries. These lookup details never determine palette order.

Both source stride signs and nonzero-X views remain supported. Scans do not
advance the source pointer after their final row. Source pixels and padding
are never written.

## Validation and measurement

The PNG tests use a separate linear first-seen color dictionary as their
compatibility oracle. It shares none of the production hashing, probe, run
reuse or fused preparation code. Tests compare complete PNG payload bytes and
then decode every pixel with real Cairo/libpng. Coverage includes all palette
packing boundaries, grayscale, deliberate collisions for both the old and
new initial hash, odd widths, both stride signs, bottom-reaching subrectangles,
exact/over-cap row staging, tall narrow images, early/late high-color fallback,
palette OOM, optional/final staging OOM, libpng creation failures and output
errors before and after the first blob.

`scripts/benchmarks/png-preparation.c` compares the production helper with a
reproduction of private.9's palette-build and separate-index passes. Invoke
`legacy SAMPLES` or `fused SAMPLES` (2–100,000); each case has 20 warm-ups.
It checks palette order, all indices and source immutability outside the timed
loop. The timed interval includes preparation, allocation, release, allocation
counter updates and clock overhead. Numeric output includes allocation counts
and requested bytes; no image payload is emitted or retained after the case.
No libpng compression, Cairo fallback encoding, protocol, worker scheduling,
network or browser work is measured.

Build against the candidate's Cairo and libguac dependencies, including its
private libguac headers. `GUAC_PNG_PALETTE_SOURCE` can override the included
palette source with an absolute component-image path. The driver renames the
included private functions rather than replacing the image's exported encoder.
Run both orders to inspect cache/host drift. This isolated comparison is not
a source-matched old/new library benchmark or a full-frame speed claim.

The fixtures include easy repeated-color runs as well as grayscale, both
initial-hash collision sets, large/tall indexed images and early/late
high-color rejection. Easy palettes may gain little or incur extra preparation
overhead; a late high-color image can allocate the bounded speculative block
that the old path avoided. Full production comparisons must include those
tradeoffs, equal realized codec/quality/image work, exact encoded-output
fingerprints in a separate integrity pass and independent decoded pixel replay.
