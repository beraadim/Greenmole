# Production display benchmark

`scripts/benchmark-display-production.py` compiles the same C harness against
each image's own headers and libguac, then exercises production planning,
rolling copy search, worker admission, FIFO scheduling, codecs, and serialized
protocol output. It does not include desktop capture, FreeRDP transport,
Guacamole's browser renderer, Wi-Fi, physical input, or frame pacing. A frame
completion time here is not an end-to-end input latency measurement.

## Source and policy controls

Use `--baseline-revision` and `--candidate-revision` with full Git revisions.
The wrapper requires each image's OCI revision label to match before running,
then executes the inspected immutable image ID. Results include those image
identities, revisions, and a SHA-256 digest of the shared C harness. A matching
label is a build provenance check; it cannot establish the contents of an
arbitrarily relabeled third-party image. Build both stages from the intended
source snapshots first.

The default comparison is `baseline` against `adaptive`. Baseline does not call
the policy setter: private.6 retains its shipped twelve-worker admission cap.
The presence of its policy symbol does not identify an old fixed-worker build.
Adaptive calls the private setter with **1**, which enables the library's
default adaptive cap of twelve; it does not request one encoder. Values greater
than one select an explicit cap. `adaptive-8`, `adaptive-12`, and `adaptive-16`
are tuning controls. `fixed` passes zero and is a separate full-pool diagnostic,
not the private.6 performance comparator.

Each case records the actual worker pool and observed active limits. The legacy
`test_active_cap` field is the harness control argument; use
`policy_setter_value` to distinguish the actual call (`null` for untouched
baseline, zero for fixed, one for default adaptive), and the observed limits to
describe admission behavior. The pool defaults to 22 workers in every mode.
Run both the normal mode order and `--reverse` to reveal host/order drift.

## Controlled photo encoding

Automatic encoding is the default (`--codec auto`). It preserves the tested
library's format and quality decisions, including its existing framerate-based
PNG/WebP/JPEG selection. A faster unpaced fixture can cross that threshold, so
automatic full-frame time/CPU comparisons may include different encoded output.
They cannot establish equal-quality encoder improvements merely because image
area is unchanged.

Use `--codec png`, `--codec webp-lossless`, `--codec webp-lossy`, or `--codec jpeg`
to hold the encoder path fixed. `--quality 75` (the default control value)
selects JPEG/WebP quality; for lossless WebP it controls compression effort,
not visual quality. PNG ignores that value. Auto ignores it and records the
actual quality range selected by the library. JPEG requires an opaque layer
that permits lossy output. WebP requires client support, and forced lossy WebP
cannot replace an explicitly lossless layer.

For example, pass these options to the usual source-matched baseline/candidate
invocation to compare the principal photo cases at WebP quality 75:

```text
--codec webp-lossy --quality 75 --samples 60 --warmup 10
--cases wallpaper-4k partial-photo-on-4k small-photo-on-4k window-1920x944 window-2560x1304
```

The controls exist only inside the benchmark executable. ELF symbol
interposition forwards auto selection to the original selector; fixed mode
replaces its decision and bypasses content/framerate classification work. Every
encoder call still uses that image's real implementation. No codec source is
copied and no production setting is added. Fixed-mode format timings therefore
do not measure the library's automatic classifier. This also works
with private.7's own headers/library. Older or locally bound libraries that
bypass the hooks fail coverage checks rather than silently reverting to auto.
The harness verifies every measured frame's selector/encoder call counts against
the production plan, the actual codec, quality and lossless mode. It also counts
actual encoded blob bytes within each encoder's thread-local scope, excluding
stream IDs, timestamps, base64 expansion and other serialized protocol text.
No encoded payload is retained or logged by this observer.

Before publishing a fixed-codec comparison, the wrapper requires identical
codec calls, actual image pixels, encoder payload bytes, quality ranges and
WebP lossless-mode counts across the requested runs. A mismatch fails the
comparison. Total protocol bytes may differ slightly because concurrent stream
IDs or timestamps differ; that does not indicate different image quality.
Codec/quality equality controls workload confounds but is not a general visual
quality assessment or proof that two different codec versions are bit-identical.

`encoder_observation` records bounded numeric counts and wall times around the
real encoder calls. Those envelopes include image conversion, codec work and
interleaved streaming/serialization/socket waits. They are **not pure encoding
CPU**. Summed parallel-worker durations can exceed frame wall time, and their
p95 is the percentile of per-frame sums rather than per-image or frame-latency
percentiles. Observation adds clocks and one statistics update per image plus
a fixed increment per encoded blob on both old/new libraries; compare only
records using the same harness. The separate correctness replay disables all
fixed overrides and observations and forces lossless output as before.

## Optional render diagnostics

`--render-diagnostics` enables the private numeric render getter in supporting
libraries through `GUAC_DISPLAY_DIAGNOSTICS=1`. Older libraries such as private.7
report `render_statistics: null`. Use a separate diagnostic run when the
baseline cannot collect equivalent telemetry, since new clocks add overhead.
No image content or extra protocol fields are exposed.

The harness snapshots the optional sixteen-value getter outside the full-frame
timed interval. Counters are cumulative integer microseconds; measured-frame
deltas produce per-frame mean/p95 of summed queue wait, committed-frame lock
wait, format selection, codec/protocol streaming, blob sending, final frame
completion, and batch elapsed wall time. It cross-checks image/codec/pixel/blob
counts against the independent encoder observers and requires exactly one
published completion per measured frame. Lifetime queue/stream maxima are
explicitly labeled and include initialization and warm-up.

Queue wait begins at batch publication and ends at image admission; later
images naturally include time spent waiting behind earlier encoders. The
stream envelope includes nested blob sending, so these durations overlap.
Subtracting blob time leaves a codec/serialization/socket-lock residual, not
standalone codec CPU. Final completion includes sync, backing-buffer copies and
socket flush. None measures capture, browser presentation, network delivery or
physical-input latency; sums and independent p95 values are not additive.

## Fixtures

The original nine cases retain their dimensions and generation logic:
`small-text`, `scroll-text`, `partial-text-redraw`, `mixed-4k-desktop`,
`wallpaper-4k`, `partial-photo-on-4k`, `small-photo-on-4k`, `window-1920x944`,
and `window-2560x1304`.

Five additional cases isolate planner behavior:

| Case | Purpose |
| --- | --- |
| `solid-color-4k` | Changing full-desktop fills with no image-copy candidates |
| `no-copy-hit` | Fresh deterministic noise in a 1920×1440 region on 4K; candidates with no exact source match |
| `early-copy-hit` | A 64×64 tile copied from near the beginning of a 1024×1024 source scan |
| `late-copy-hit` | A tile copied from near the end of that scan |
| `planner-reuse-alternating` | Changing text-like patches whose extents alternate between 160×90, 1024×768, and 1920×1440 on 4K |

The early/late fixtures also change a distant pixel so damage refinement spans
the source desktop. Without that pixel the scan could be restricted to the
small changed tile, defeating the intended comparison. These cases use opaque,
synthetic RGB pixels rather than recorded user content.

## Timing and retained work

Each scenario runs in a fresh child, with its own display and encoder pool.
Initial full-frame setup, fixture generation, and configurable warm-up frames
are excluded. Timed frames include writing pixels into the production display
through completed serialization to a shared discard socket. Completion also
waits for an empty FIFO and zero active workers. The socket serializes concurrent
worker writes using the normal socket lock contract.

Output records nearest-rank p50/p95 wall times, process CPU per frame, protocol
bytes per frame, and peak child RSS before correctness replay. It copies timing
summaries before releasing sample storage. The wrapper rejects non-finite or
nonpositive frame/CPU summaries and out-of-order p50/p95 values. This guards malformed summaries;
it does not replace repeated runs or account for unrelated host load.

The optional numeric getter described in [display-planner.md](display-planner.md)
is resolved dynamically. Counter deltas cover only measured frames, excluding
warm-up, and are read outside the timed interval. Retained scratch bytes are
reported as final and peak gauges. Older libraries without the getter report
`planner_statistics: null`, never invented zero allocations or search work.
Copy-window counts include complete 64×64 windows, not rolling-hash warm-up
pixels. Changed operation mixing can affect encoding work, so compare counters,
CPU, bytes, and frame times together.

`planning_phase_ms` additionally records mean and p95 for each of the existing
numeric TRACE phases: draft, rects, search, combine, and commit. The handler
captures five fixed integers per frame without formatting messages, retaining
strings, or adding clock reads. Each measured frame must provide all five
phases. Both versions use this same harness, and the full-frame interval remains
unchanged. Its log capture cost is included in that interval; sample copying,
sorting, and summaries occur afterward.

These phase durations are **integer-millisecond wall times**, including any
scheduling delay during the phase, rather than process CPU measurements. Zero
is valid for short phases. In particular phase 3 (`search`) includes candidate
indexing **and** rolling copy search. The phase ends before worker encoding and
serialization, which helps distinguish planning work from downstream tails.
Independent p95 values cannot be subtracted to derive an encoder p95, and these
coarse values cannot establish sub-millisecond differences.

## Independent correctness replay

After recording timing/RSS and freeing the measured display, the harness creates
a separate display and forces lossless output. Four frames per scenario are
checked by default (`--verify-frames 0..10`). An independent incremental ASCII
protocol parser reconstructs the serialized output into Cairo image surfaces,
including fills, overlapping copies with snapshot semantics, and streamed images
decoded through real PNG and lossless WebP decoders. Every checked frame must
have its expected sync, no partial instruction, and no open image stream.

The harness compares every visible RGB pixel, including untouched regions,
against a separately maintained expected canvas after each frame. It exits with
failure on mismatches or unsupported output. Results include pixels compared,
instruction/image/copy/fill counts, and a final numeric RGB hash; they contain no
image or protocol payloads. Matching hashes across versions supplement each
version's direct expected-pixel checks.

This is a deliberately bounded verifier for opaque, fixed-size, single-visible-
layer fixtures. It supports eight surfaces, 128 image streams, 128 arguments per
instruction, 32 KiB of argument text, and up to 64 MiB of encoded bytes per
stream. It is not a general protocol client, alpha-compositing validator, browser
renderer test, or resize test. Forced-lossless replay proves these fixture
updates retain exact pixels; it does not require lossy timed output to be exact.
Malformed text, including embedded NUL, fails validation. Replay errors terminate
the isolated case child so active workers never outlive its stack-based sink.

Containers have no network, a read-only root, a read-only harness mount, a
bounded writable tmpfs, dropped capabilities, no-new-privileges, and memory/PID
limits. No live configuration or user desktop is accessed by this benchmark.
