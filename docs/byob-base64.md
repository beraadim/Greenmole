# Base64 BYOB study: candidate rejected

Private.12 retains the production `InputStream.js` and its stream tests exactly
as shipped in private.11. A candidate decoded complete Base64 blobs directly
into outstanding BYOB buffers, avoiding one temporary payload buffer and copy
per eligible blob. Actual browser measurements rejected that candidate: the
validation needed to preserve invalid-input behavior outweighed the saved copy.
It is preserved in commit `6046fa964` for reproducible study, not shipped in the
final client. There is no image quality, wire protocol or blob framing change.

## Why the candidate needed validation

The native `Uint8Array.prototype.setFromBase64()` method can partly write before
throwing on malformed input. Optimistically trying it and then falling back
would corrupt a consumer's pending buffer. The candidate therefore required a
complete independent blob, a sufficiently large outstanding BYOB view, the
standard Base64 alphabet, complete quartets, canonical padding and zero unused
bits before any write. Its guard used a true end-of-string assertion because a
JavaScript `$` anchor also matches before a trailing line break. Whitespace,
omitted padding, nonzero unused bits, oversized blobs, normal readers and older
browsers retained the existing decoder and accepted-input/error behavior.
Offsets, DataView consumers, EOF and cancellation were preserved. See the
[native API specification](https://tc39.es/proposal-arraybuffer-base64/spec/)
for the method's capacity, errors and returned counts.

The candidate's native and deterministic regression cases passed, including
invalid blobs that must leave consumer-buffer sentinels unchanged, terminal
ASCII line breaks, cancellation and API absence. Those experimental tests are
also preserved in the candidate commit. Correctness alone did not establish a
performance improvement.

## Reproduce the explicit BYOB experiment

Node.js 22+ and an installed Chrome/Chromium are required. The driver launches a
separate headless browser with its normal sandbox, a temporary isolated profile
and loopback-only debugging. It needs no npm dependencies, real connection,
clipboard data or runtime configuration. Set `CHROME_BIN` or use `--browser`
outside the default macOS Chrome location.

```sh
node scripts/benchmark-browser-byob.mjs \
  --baseline 1.6.1-private.11 --candidate 6046fa964 \
  --samples 4 --output local/byob-study.json
```

Both constructors and `ArrayBufferReader` are loaded from exact Git commits.
The result records resolved revisions, source/driver hashes and actual browser
API availability. It uses real native BYOB reads, canonical independent blobs,
byte offset 3, and backing buffers returned from the preceding read. Timings
include the candidate's full validation scan, native decoding, stream delivery,
buffer transfers and Promise continuations. Final complete bytes, geometry,
outside-view sentinels and EOF are checked outside each trial's timer.

Each version/size first performs two counted verification reads and 128
uncounted warm-up reads. Four timing samples alternate A/B and B/A. Counts are
never installed in timing trials. Verification records show that the baseline
allocates/copies one full decoded payload per read while the candidate decodes
directly with no such copy. Neither path is allocation-free overall.

The frozen-driver Chrome 155 run found the candidate **2.8 to 6.4 times
slower** across 6,144-byte, 65,535-byte and 1-MiB blobs, despite eliminating those
buffers/copies. This is a synthetic generic stream experiment, not an isolated
Base64 CPU test, garbage-collection measurement or live image/network benchmark.
Raw release evidence retains every timed trial and separate structural counts.

## Real image decoder observations

A separate actual WebSocket/Parser/Client/ImageDecoder replay found **zero
outstanding BYOB requests** from Chrome 155's PNG and WebP consumption. Both
client versions used the existing allocating path and performed no BYOB payload
copies. Native API support alone does not mean the image decoder uses BYOB.
Thus there was neither a current image-path opportunity nor a generic-consumer
speedup supporting shipment of this candidate.

`benchmark-browser-image-pipeline.mjs --base64-counts on` retains useful opt-in
structural counters only in separate untimed verification documents, after
reference construction. Timing runs do not install them and report
`base64_read_counts: null`. Counts cover native direct decodes, buffers delivered
by `ArrayBufferReader`, copies from those buffers through `Uint8Array.set()`,
and unique BYOB requests observed via the native controller getter. Query counts
are not unique request counts. They do not measure heap usage, decoder-internal
copies or CPU savings.

`--pipeline-diagnostics on` separately enables the optional Client diagnostic API
and stores its numeric snapshot. Both selected versions must provide the API;
use `--client-ref` with the committed new client for identical-bundle replay.
Diagnostics remain disabled by default. See [the full pipeline replay
documentation](browser-image-pipeline.md) for measurement and pacing limits.
