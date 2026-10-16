# Lossless PNG compression study

This is benchmark infrastructure, not a new production setting. The production
PNG encoder, palette, compression/filter defaults and high-color/ARGB Cairo
fallback are unchanged. A faster compressor is useful only if its CPU/frame
benefit survives the transfer-size, browser-decode and delivery tradeoff.

## Controls and coverage

`scripts/benchmarks/png-compression-control.c` interposes the executable's
`png_write_png()` call and forwards to the image's real libpng. Initialize it
once before workers or `fork()` with
`benchmark_png_control_initialize(level, filter, strategy)`. Invalid/repeated
initialization or an unresolved real function returns zero. No environment
setting is read, and the configuration stays immutable while workers run.

Supported benchmark choices are:

| Setting | Values | Meaning |
| --- | --- | --- |
| Level | `default`, `1`, `3` | `default` leaves the library's compression level untouched |
| Filter | `default`, `none`, `up`, `fast` | `fast` allows libpng to choose among None/Sub/Up per row |
| Strategy | `default`, `rle` | RLE is an explicit diagnostic, never an assumed improvement |

The hook applies setters only when the image is `PNG_COLOR_TYPE_PALETTE`.
Nonpalette calls forward unchanged. Cairo's normal writer remains responsible
for high-color and ARGB images. The helper does not change image geometry,
quantize colors or introduce lossy encoding. PNG bytes can change when settings
change, while decoded pixels must stay identical. The IHDR filter-method field
is not the per-row filter-choice policy.

Relaxed numeric counters record indexed calls/pixels and each requested setter
application. Callers snapshot only after workers finish. The native production
driver also captures a bounded 26-byte PNG header prefix and the thread-local
hook sequence per image. Each encoded indexed PNG must reach exactly one
control hook; other PNGs must reach none. Independent header-derived counts and
pixels must agree with the helper. Missed/duplicated hooks fail the child.

Study builds separately observe indexed and Cairo-fallback call/pixel/byte
counts. Optional fallback fingerprints remain strict across variants, including
mixed frames. No image payload is retained or logged by these observations.
The helper adds per-image header copying, TLS access and relaxed numeric
counter work. These costs belong to the study, and need an overhead control.
There are no diagnostic clock reads within the compression helper itself.

## Native comparisons

The Python production wrapper links the helper only with `--png-study` and an
enabled side. Ordinary comparisons omit it and keep strict encoded-byte and
fingerprint equality. Study comparisons require `--codec png`, preserving
realized image work while deliberately changing only indexed PNG settings.
For example, compare one pinned image against itself:

```sh
python3 scripts/benchmark-display-production.py \
  --baseline-image guacamole-private/native-benchmark:1.6.1-private.10 \
  --candidate-image guacamole-private/native-benchmark:1.6.1-private.10 \
  --baseline-revision e1d2762776905f68b5a35b1b957b82b35a02311b \
  --candidate-revision e1d2762776905f68b5a35b1b957b82b35a02311b \
  --codec png --png-study --candidate-png-level 1 \
  --cases small-text scroll-text partial-text-redraw \
  --samples 100 --warmup 10 --verify-frames 4 \
  --modes baseline adaptive adaptive baseline
```

Use `--candidate-png-filter up` or `fast` to study filter choices, optionally
with an explicit level. The baseline counterparts accept the same choices.
`--baseline-png-level off --candidate-png-level default` compiles one side
without the hook for a default/default overhead check. `off` may only be paired
with semantically default settings, so a missing hook cannot hide a policy
comparison. Both enabled default/default sides also verify pure forwarding.

The JSON records source labels, immutable image IDs, native driver/wrapper and
helper/header SHA-256 values, settings and measured coverage. Calls, geometry,
pixel areas, quality and lossless mode must match. When enabled, strict pixel
replay counts and final canvas hashes must match too. Equal settings still
require equal PNG bytes/fingerprints. Different settings can vary indexed PNG
bytes only; zero-indexed Cairo cases, mixed-case fallback observations and
other codecs remain strict. Per-codec byte deltas identify the reference run
and execution slot, so reversing order does not mislabel a candidate as the
baseline.

These same-image experiments are policy studies, not a source-matched release
comparison. Confirm selected candidates on the final implementation and
baseline image with one frozen harness, balanced order, equal work and explicit
CPU/p95/byte tradeoffs. Preserve initial negative results and later controls.
Never infer network or browser improvement from the shared discard socket.

## Browser/export integration

The same helper can link into an isolated asset exporter that invokes the real
Guacamole PNG encoder. Call initialization before exporting and include the
control's measured coverage alongside source/image identities and bytes.
Independent native decoding must first establish exact expected RGB pixels
for the opaque fixtures.
The browser replay then uses those actual encoded bytes, explicit pacing and
constrained delivery, checking canvas pixels and acknowledgement callbacks.
Asset export/oracle construction and pixel readback stay outside timed encoder
or decode/acknowledgement intervals. A simple patterned asset can favor a
filter that loses on representative production text, so both measurements
are required.

No compression policy should ship on a preparation microbenchmark or a lone
fixture. Review frame p50/p95, total process CPU, payload/protocol bytes, browser
decode/canvas/acknowledgement time and queue growth at representative bandwidth
and latency. PNG compression changes preserve pixels, but extra bytes can make
the user experience worse on Wi-Fi.

## Regression checks

`python3 scripts/test-display-production-controls.py` tests the comparison
gate without Docker: default strictness, explicit PNG-only variation, geometry
and pixel equality, indexed coverage, unchanged mixed/zero-indexed fallback,
other-codec integrity and reverse-order provenance.

`scripts/benchmarks/png-compression-regressions.c` runs all fourteen real PNG
test functions with a selected setting, using the existing independent linear
palette oracle, real libpng/Cairo decode and allocation/output fault injection.
Build this isolated runner with the helper, the native image's config/private
headers, real libguac/Cairo/libpng/CUnit, `-ldl`, `--export-dynamic`, and
`GUAC_PNG_TEST_SOURCE` pointing at that image's saved PNG test source. It also
checks invalid initialization and rejects reconfiguration after publication.
Run the Cartesian product of three levels, four filters and two strategies;
all 24 configurations must retain pixels, packing and cleanup behavior. Exact
payload equality is checked within each configuration, not falsely required
across different compression choices.

Local focused validation uses an isolated assertion runner with actual encoder
source and real Cairo/libpng: 24 configurations ×14 functions, **336 UBSan test
executions**, plus invalid-setting rejection and strict syntax checks with the
control linked and omitted. This is separate from final Linux native gates and
full production/browser performance evidence.
