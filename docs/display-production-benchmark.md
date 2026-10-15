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
