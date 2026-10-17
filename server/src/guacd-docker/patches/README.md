# Reviewed FreeRDP AVC444 SIMD corrections

`freerdp-avc444-ssse3-odd-chroma.patch` applies only to FreeRDP commit
`9b678b6d5a40ce01607d8c3b1b1416437c8416c4`, retained by the private release
manifest. Its source is Apache-2.0 licensed and comes from
[FreeRDP prim_YUV_ssse3.c](https://github.com/FreeRDP/FreeRDP/blob/9b678b6d5a40ce01607d8c3b1b1416437c8416c4/libfreerdp/primitives/prim_YUV_ssse3.c).

The AVC444v1 B6/B7 SIMD loop unpacks each auxiliary U/V sample into even byte
positions, then mask-writes those even positions into the full-resolution
chroma plane. The destination must start one byte later: normative B6/B7
places these samples at odd columns on even rows. The existing scalar tail
already writes `2*x+1`. All four stores (two halves of U and V) receive this
one-byte correction. Each final enabled byte remains within the same row.

The shared chroma inverse-filter loop also advances by 16 pixel pairs while
its SIMD helper handles only eight pairs. It therefore leaves the second half
of every 32-pixel block as a subsampled average. Two additional helper calls
(one U and one V) complete that same bounded block. This fixes the same
inverse-filter omission for both v1 and v2; loop bounds and scalar tails are
unchanged. No SIMD path is disabled and no unrelated primitive is changed.

The build hook checks the complete original source file and patch SHA-256,
then checks and applies the patch. The dependency commit remains unchanged.
A different dependency revision needs a new review rather than a fuzzy patch.
`gdi/avc444-primitives.c` compares the selected optimized and scalar primitives
for every chroma sample and output pixel, for both v1 and v2.
The end-to-end synthetic RDP/browser test additionally checks the complete
image fallback, preventing matching browser/encoder formulas from hiding a
native decoder discrepancy.

The regression was run against the installed pinned library in isolated build
containers: the original implementation failed 7,037 of 25,801 assertions;
the odd-column fix alone still failed 2,329; both corrections pass all 25,801.
Aligned 64x32 and scalar-tail 62x30 cases pass independently for v1 and v2.
