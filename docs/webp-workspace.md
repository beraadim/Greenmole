# Bounded worker WebP input workspace

The display worker binds one lazy, thread-confined ARGB input workspace for its
lifetime. `guac_webp_write()` remains the exported encoder entrypoint and the
worker still reaches it through `guac_client_stream_webp()`. Benchmark ELF
interposition therefore observes the same real encoder calls as before.

Only the packed input allocation is reused. The preset remains
`WEBP_PRESET_DEFAULT`, method 2, thread level 0, and the supplied quality and
lossless values are unchanged. Each call initializes a new `WebPPicture` and
releases its libwebp-owned conversion/encoder scratch. The caller-owned ARGB
input behavior is supported by libwebp's
[picture API](https://github.com/webmproject/libwebp/blob/v1.6.0/src/webp/encode.h).
No codec policy, environment setting, image order, or normal-path clock is added.

## Ownership and bounds

The input buffer grows geometrically and retains at most **2 MiB per worker**.
The bound was chosen from private.8 production photo fixtures: 42/80 full-photo,
20/30 partial-photo and 8/16 small-photo images exceeded 1 MiB of packed input;
none exceeded 2 MiB. The largest was 491,520 pixels (1,966,080 bytes). Thus the
smaller 1 MiB proposal would miss many representative tiles despite the
planner's nominal 512×512 comment. These are eligibility measurements, not
timing or cache-hit claims.

At most 44 MiB is retained with Oberon's 22 workers, or 128 MiB with the allowed
64-worker maximum. Allocation is lazy; small-only sessions retain less. These
bounds cover retained ARGB input only, not other libwebp scratch, layer buffers,
or transient allocations. Non-worker calls, a nested encode using an already
busy workspace, and images above the bound use the original transient picture
allocation. Failed rounded cache growth preserves the preceding allocation and
tries that exact-sized transient path before failing the image.

The workspace scope uses configure-tested compiler TLS. Compilers without that
support keep all encodes transient; no additional pthread lookup or TLS
allocation is introduced there. A worker restores its previous binding and
frees retained input after its encode loop exits. Display shutdown invalidates
the queue and joins workers, so the buffer is not freed while a synchronous
encode is using it. Partially created pools have the same per-thread cleanup.

RGB24 always copies into the workspace and forces alpha to `0xFF`; its unused
high byte is not valid alpha. ARGB32 copies each row without changing the source
or padding. Positive/negative byte strides and nonzero-origin image views are
preserved. Row pointers are not advanced after the final row, including views
that end exactly at the backing allocation's bottom. Source pixels are never
used as mutable encoder workspace.

## Validation and measurement

Focused tests compare prepared pixels with the legacy allocation/copy path,
then compare complete encoded payload bytes for lossy/lossless output at
qualities 0, 75 and 100. Lossless decode checks opaque RGB and all alpha values;
RGB under fully transparent alpha retains the existing default `exact=0`
behavior and is covered by legacy payload equality instead of a new stronger
guarantee. Tests also cover changing dimensions, row padding, negative strides,
bottom-reaching subrectangles, strict retention boundaries, oversized/nested
calls, failed cache growth with successful transient fallback, total allocation
failure, encode failure, scoped A→B→A restoration, thread isolation and cleanup.

`scripts/benchmarks/webp-preparation.c` compares the production preparation
helper with a reproduction of private.8's picture allocation and row copy.
It measures initialization, allocation, copying and input release only; it
never calls `WebPEncode()` in the timed path. Both modes use the same synthetic
source and check exact prepared pixels/source immutability before reporting.
Allocation counts, retained bytes and cached-call counts make the cap behavior
visible. All preparation measurements must remain separate from full encoder
or production-frame latency claims.

The benchmark accepts `legacy SAMPLES` or `workspace SAMPLES` (2–100,000), with
20 warm-ups and seven fixed fixtures, including the observed 960×512 maximum
and a true over-cap 1025×512 image. Build it against the candidate's own
source and dependency libraries. Within a component build image, override
`GUAC_WEBP_PREPARATION_SOURCE` to the absolute saved `encode-webp.c` path and
include that image's libguac headers; link libguac, Cairo and libwebp as with the
production harness. Run both orders to inspect host/cache drift. The standalone
comparison is not a source-matched old/new library benchmark; release claims
also require the normal production path with fixed codec/quality, identical
image work and encoded-output fingerprints enabled in a separate integrity run.
