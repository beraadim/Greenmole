# Browser image pipeline replay

`scripts/benchmark-browser-image-pipeline.mjs` measures real loopback WebSocket
delivery through the unmodified Guacamole `WebSocketTunnel`, receive pump,
`Parser`, `Client`, image streams, native image decoding, canvas drawing, and
actual outgoing `sync` acknowledgements. It complements the existing render,
protocol, timer, and readiness benchmarks without changing their behavior.
There is no production instrumentation or browser optimization in this change.

The downstream sender applies deterministic source pacing, byte serialization,
release delay and seeded jitter to prerecorded `img/blob/end/sync` instructions.
Each image has multiple independently decodable Base64 blobs; instruction
lengths and payloads cross deliberately awkward WebSocket message boundaries.
These are complete WebSocket messages containing fragments of Guacamole text,
not fragmented RFC6455 server frames. Native browser WebSocket framing and the
real incremental Guacamole parser are exercised. Keepalive replies are queued
until a complete instruction boundary so they cannot corrupt a split payload.

## Running

Requires Node.js 22+ and a locally installed Chrome/Chromium. No npm packages are
needed. The HTTP/WebSocket endpoint binds only to 127.0.0.1 and uses an ephemeral
port and temporary browser profile. `CHROME_BIN` or `--browser` selects Chrome.

Run the endpoint, framing, fixture and cleanup regressions:

```sh
node --test scripts/test-browser-image-pipeline.mjs
```

Replay identical production payloads against the identical committed client
bundle as a control. Replace the revision with the full revision being tested:

```sh
node scripts/benchmark-browser-image-pipeline.mjs \
  --fixture local/private11-baseline-browser-fixture.json \
  --client-ref e1d2762776905f68b5a35b1b957b82b35a02311b \
  --samples 4 --frames 12 --warmup 2 \
  --profiles healthy,lan,constrained,jitter \
  --output local/private11-browser-image-control.json
```

For an encoder payload comparison, use the same client reference for both
manifests. Different geometry, canonical decoded frame pixels, or MIME types
fail before timed measurements:

```sh
node scripts/benchmark-browser-image-pipeline.mjs \
  --fixture local/private11-baseline-browser-fixture.json \
  --candidate-fixture local/private11-study-level1-browser-fixture.json \
  --client-ref e1d2762776905f68b5a35b1b957b82b35a02311b \
  --cases png-1,png-40,png-128 \
  --samples 4 --frames 12 --warmup 2 \
  --profiles healthy,lan,constrained,jitter \
  --output local/private11-browser-image-level1-study.json
```

This second command is a benchmark-only compression-policy study, not a change
to production settings. Native CPU/encode latency and encoded byte counts must
be evaluated alongside transfer and browser results before selecting a policy.
The control and study can retain the current production defaults regardless of
any preparation-only or isolated encoder result.

For a client-code comparison, omit `--candidate-fixture` and use `--baseline ref`
(default `1.6.1-private.10`) versus the working client tree. Do not combine client
and payload changes in a single comparison. `--client-ref ref` instead binds
both labels to exactly the same committed client bundle. Samples alternate
A/B then B/A; raw samples and arithmetic means of per-run p95 values are saved.
Those means are not pooled-frame percentiles. Run no other browser benchmarks
at the same time. Four samples are a useful first comparison, not proof that
small differences are repeatable; retain controls and longer followups.

Without a fixture, the driver generates deterministic opaque UI images using
browser canvas PNG/WebP encoders before any timings. `--write-fixture file`
saves that fallback manifest. Such results are browser-generated fixtures,
not production encoder evidence. Use `--cases id,...`, `--profiles name,...`,
`--interval milliseconds`, or smaller frame counts for a quick smoke test.

## Production payload export and provenance

On a build host containing the pinned native-stage image:

```sh
python3 scripts/export-browser-image-fixture.py \
  --image guacamole-private/native-benchmark:1.6.1-private.10 \
  --revision e1d2762776905f68b5a35b1b957b82b35a02311b \
  --output local/private11-baseline-browser-fixture.json

python3 scripts/export-browser-image-fixture.py \
  --image guacamole-private/native-benchmark:1.6.1-private.10 \
  --revision e1d2762776905f68b5a35b1b957b82b35a02311b \
  --png-control --png-level 1 --png-filter default --png-strategy default \
  --output local/private11-study-level1-browser-fixture.json
```

The exporter resolves and records the exact image ID, verifies its OCI revision,
and compiles the separate synthetic asset helper against that image's actual
`libguac`. It calls `guac_png_write()` and `guac_webp_write()` and intercepts the
encoded bytes while forwarding real blob serialization to a discard socket.
It does not export a live desktop or run the RDP capture/display planner.
The replay constructs valid surrounding image instructions from these payloads;
it does not claim to replay a complete captured guacd session.

For every asset, the native helper verifies source pixels were unchanged after
encoding. PNG is independently decoded through Cairo and checked against the
deterministic source generator formula. WebP is lossy quality 90/method 2; native
checks cover its encoded dimensions, not original-source pixel equality. The
browser checks decoded output as described below. Each asset's one sequential
encode duration is informational metadata, excluded from replay timings and
insufficient by itself for an encoder performance comparison. Compression study
hooks must report every indexed PNG invocation and are absent from production.

Manifests follow this schema (the full production exporter supplies 6 scenarios,
two variants and 20 assets):

```json
{
  "schema": "guacamole-image-pipeline-fixture-v1",
  "provenance": {
    "source_revision": "full source commit",
    "image_id": "sha256:exact image ID",
    "generator": "scripts/benchmarks/export-image-assets.c",
    "generator_sha256": "generator source hash",
    "encoder_note": "encoder/control details"
  },
  "assets": [{
    "id": "png-full-v0-t0", "mimetype": "image/png",
    "width": 1920, "height": 944, "data_base64": "encoded bytes",
    "encoded_sha256": "encoded byte hash", "encode_ms": 6.0
  }],
  "scenarios": [{
    "id": "png-1", "width": 1920, "height": 944,
    "frames": [{"images": [{"asset": "png-full-v0-t0", "x": 0, "y": 0}]}]
  }]
}
```

The driver records manifest and individual payload hashes, native provenance,
exact client revisions/bundle hashes, browser version/platform, and all driver
and helper hashes. If benchmark sources change during a run, it rejects the
record. Input is restricted to PNG/WebP, opaque full-cover nonoverlapping frames,
bounded dimensions/assets/templates, and canonical Base64. The manifest is
data only; no external URLs, credentials or source code are executed from it.

## Correctness and WebP color representations

Each source/payload version first gets a separate untimed, ACK-gated verification
pass that compares every RGBA byte after every template frame. Timing runs avoid
that per-frame readback cost and check final RGBA after the last timed ACK. All
runs check incoming frame order, actual drawing order/coordinates/counts, and
one ordered outgoing `sync` ACK per frame, observed by both browser and endpoint.
A short excluded quiet period catches late duplicates. Queue drain is required.

PNG uses independent `Image`/data-URI decoding as reference. Chrome may decode
the same lossy WebP stream to I420 or BGRX according to arrival timing; GPU YUV
conversion and the RGB decoder can differ by one channel value. Therefore the
checker precomputes two exact references outside Guacamole: CPU-canvas
`Image`/RGB and complete-buffer `ImageDecoder` native output on an ordinary
canvas. It records each actual `VideoFrame.format` and selects that format's
reference for each image. The reference is never selected by pixel similarity,
and no tolerance or ignored mismatch is permitted. Unsupported formats fail.

The canonical full-frame RGB and native-reference SHA256 arrays must both match
between baseline and candidate before timing. Mixed-format frames are rebuilt
from their recorded per-image modes outside timings. The native WebP reference
uses the same browser decoder implementation, so this validates byte delivery,
streaming, composition and output invariance, not the correctness of that decoder
algorithm or lossless preservation of original WebP source pixels.

## Interpreting the stages

The profiles request the following application-level downstream shaping:

| Profile | Byte rate | Initial release delay/frame | Seeded jitter | Extra pause |
| --- | ---: | ---: | ---: | ---: |
| healthy | unlimited | 0 ms | 0 ms | none |
| lan | 12.5 MB/s (100 Mb/s) | 1 ms | 0 ms | none |
| constrained | 1.25 MB/s (10 Mb/s) | 20 ms | ±3 ms | none |
| jitter | 2.5 MB/s (20 Mb/s) | 8 ms | ±8 ms | 25 ms every 17 fragments |

The recorded achieved protocol byte rate, send-gap distribution, release timing
error and fragment size distribution describe what actually happened. The data byte
rate includes source pacing/idle time and excludes initialization/control text;
keepalive reply counts/bytes are recorded separately. Send timestamps are application writes,
not kernel arrival times. Node timer resolution and browser/host scheduling can
change the achieved profile. Source frames are scheduled at 16 ms by default;
the sender respects socket backpressure and never drops dependent frames.

Sender transfer span, final-write→ACK-received, and source-due→ACK-received all
use the sender's monotonic clock. Browser first-image-dispatch→sync includes
arrival, parsing and handlers; sync-dispatch→ACK includes remaining decoding,
frame wait and drawing. Last-image-end→first-draw is a combined decode/backlog
interval, not isolated decoder CPU. Draw-call sums and handler durations overlap
some intervals and must not be added as independent pipeline stages. Decoding
can overlap transfer. Browser and sender clocks are never subtracted.

Pending display frames/oldest age are sampled and recorded at ACKs, with peaks
and net sampled growth. Short queue spikes can occur between samples; zero
sampled growth alone is not evidence that latency stayed low. The endpoint also
records the maximum number of frames whose first bytes were sent without an ACK
and source-schedule delay, exposing bandwidth-driven buildup before a complete
frame reaches the display queue. `MessageChannel` probes record browser-task
delay and periodic timer lateness during measured frames, not physical input.

All state is bounded: input file 128 MiB, encoded assets 96 MiB, declared decoded
asset geometry 192 MiB (up to two RGBA references per asset), canonical
per-template RGBA 128 MiB, per-run protocol 64 MiB,
at most 70 frames/run, 10,000 periodic probes, and caps on total retained runs,
frame observations and draw metadata. WebSocket client messages/retained ACK
elements are capped at 1 MiB and continuations at 1,024 frames. Pending sends fail
on close/error; browser decoders/frames, sockets, channel ports, server and
temporary profile are cleaned up on success and failure.

This is not capture, live RDP, guacd frame pacing, TCP/Wi-Fi loss/retransmission,
RTT/congestion emulation, physical paint/FPS, or physical input latency. ACKs
travel unshaped over loopback. Do not infer an end-to-end desktop speedup from a
small isolated stage change or a single short benchmark run.
