# Browser video performance review, October 2026

The AVC420 path already sends decoded `VideoFrame` objects directly to the
ordered display operation. It does not copy frames into JavaScript RGBA buffers
or read pixels back for normal presentation. Its four submitted-frame slots,
16-envelope queue, byte limits, two-second deadlines and presentation-based ACKs
remain unchanged. Arbitrarily dropping queued H.264 pictures would break later
reference pictures, so this review does not trade correct playback for a shorter
queue.

## Implemented: native Base64 byte decoding

Both AVC players converted each compressed blob with `atob()` and copied every
byte using a JavaScript `charCodeAt()` loop. They now use the browser's native
`Uint8Array.fromBase64()` when available, followed by a typed-array copy into the
existing bounded envelope. Browsers without that optional API retain the
previous binary-string path. Input type/length validation still runs before
Base64 decoding, malformed input still causes terminal image fallback, and
fragmented or coalesced envelope boundaries retain their previous semantics.

A bounded Chrome 155 test compared the actual baseline and updated AVC420
parsers with independently encoded 4096-byte payload blobs. Packet creation was
outside timing; eight samples alternated baseline/candidate order. The test
included assembly and NAL inspection but simulated decoding and presentation.

| Payload and trial size | Baseline mean | Updated mean | Parser-stage reduction |
| --- | ---: | ---: | ---: |
| 6 KiB × 256 envelopes | 4.10 ms | 2.31 ms | 44% |
| 64 KiB × 256 envelopes | 40.19 ms | 19.50 ms | 51% |
| 1 MiB × 32 envelopes | 87.95 ms | 39.32 ms | 55% |

These percentages describe this parser stage on a modern browser, not a whole
session speedup. They do not measure the old client laptop, native H.264 decode,
Wi-Fi, GPU work, frame rate or interaction latency. The temporary native byte
array is bounded; this is not a zero-copy implementation. The older-browser path
has byte/frame/ACK verification and keeps its existing performance behavior.
The complete measurements, source hashes and limitations are recorded in
[the private.16 parser benchmark](../releases/1.6.1-private.16-browser-parser-benchmark.json).

The 259 Chrome browser tests pass with no skipped tests, including 12 new native
and legacy Base64 regressions, real AVC420 playback, and desktop-size AVC444
native-plane copying and GPU color reconstruction. The 40 frontend tests and
production frontend build also pass. The build reports the existing three
asset-size/performance warnings.

## Deferred: AVC444 texture reuse

An isolated renderer candidate retained texture storage between pictures and
updated it with `texSubImage2D()`, while caching the texture-size limit and unused
NV12 plane. It preserved neutral-color samples across I420/NV12 transitions.
At 2560×1264, four alternating trials of 30 renders averaged 66.08 ms before and
63.38 ms after: about 0.09 ms saved per render. That small result is too noisy to
justify another rendering change in this pass. The renderer remains unchanged.

AVC444 still requires two H.264 views and native-plane copying for exact color
reconstruction. At 2560×1264, its two YUV420 views contain about 9.26 MiB per
picture, before the GPU uploads. The software decoding policy required by the
current interleaved stream can therefore remain a material cost on old CPUs.
This review does not establish which stage limits a particular client. AVC420
and a lower selected frame rate remain useful client choices. A future adaptive
policy should first measure decode, plane-copy and presentation timing rather
than infer those costs from network throughput alone.
