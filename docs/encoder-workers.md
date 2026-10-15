# Encoding worker pool

`guacd` accepts the administrative environment setting
`GUAC_DISPLAY_WORKER_THREADS`. It applies to each newly created display/session:

| Value | Behavior |
| --- | --- |
| Unset, empty, or `auto` | One worker per detected CPU, respecting CPU affinity where supported, bounded to 1–64 workers. |
| Decimal integer `1` through `64` | Use the requested worker count, including a value above the detected CPU count for controlled comparison. |
| Any other value | Log a warning and use automatic selection. |

The value is not a remote connection parameter. It can only be supplied by the
administrator launching guacd, for example through the guacd container's
environment. No deployment configuration is changed by this release: Oberon's
existing affinity-aware automatic count remains 22. Cgroup CPU quotas are not
separately inferred; installations limiting CPU time without affinity should
set the worker count explicitly after measurement.

Pool allocation and thread creation are checked. If resource limits permit only
part of the requested pool, only the successfully created threads are retained
and joined during shutdown. If allocation fails or no worker can be created, the
session is stopped and its operation queue is invalidated, rather than leaving
graphical work waiting for a nonexistent worker.

## Repeatable benchmark

`scripts/benchmark-encoder-workers.py` compares 2, 4, 8, and 22 workers using the
actual PNG, JPEG, and WebP entrypoints from the release's built `libguac`, including
Guacamole blob serialization and synchronization on one shared discard socket.
It uses persistent pools and deterministic synthetic pixels, never user screen
contents, live configuration, a live connection, or a network endpoint.

Build a native `guacamole-server` Docker stage with the release manifest's pinned
arguments and source, using `--target guacamole-server` and a distinct local tag.
That stage already includes the compiler, codec libraries, and the test-gated
installed libguac. Then run on the Docker host:

```sh
python3 scripts/benchmark-encoder-workers.py \
    --docker-image guacamole-private/encoder-benchmark:1.6.1-private.4 \
    --samples 30 --warmup 5 > encoder-workers-result.json
```

If the live service uses an explicit CPU affinity, use the same affinity through
`--cpuset-cpus`. The benchmark container has no network, no capabilities, a
read-only root filesystem, a 1 GiB memory limit, and a temporary executable build
directory. The only mounted host content is its read-only C source file.

The benchmark executable requests the same 8 MiB default thread stacks used by
the native Docker build. The four scenarios are:

- Small text update: four 160×90 PNG tiles.
- Text scrolling: 48 320×180 PNG tiles.
- Full desktop: 24 640×540 tiles, split equally between PNG, JPEG, and WebP.
- Wallpaper change: 24 640×540 WebP tiles.

JPEG/WebP quality is fixed at 80, with lossy WebP. Each case runs in a fresh
process, warms up for five frames, then records 30 frame completion samples.
Count order rotates between scenarios to reduce ordering bias. JSON reports
nearest-rank p50/p95 completion time, process CPU time per measured frame,
serialized bytes per frame, and peak resident memory. Peak memory includes
warm-up and codec caches. Fixture generation and worker startup are excluded
from measured completion/CPU times. Host scheduling and concurrent workloads
can still affect results; repeat runs before selecting a lower worker count.

This isolates encoder parallelism and shared serialization. It does not measure
the display planner, adaptive grouping, RDP decode/capture, Wi-Fi, browser
decoding/painting, or input latency. The benchmark pool's frame wakeup barrier is
also separate from libguac's production FIFO scheduling. Smaller pools may use
less memory yet finish large image frames later. Keep automatic selection until
representative measurements show a consistent tradeoff worth adopting.

## Oberon measurements, 15 October 2026

One isolated run used source
`88d4b0e47e5a616b8f692c5260af8e61c1751db3` and native build-stage image
`sha256:5090b8299a666d3e84dd5e3dde3decaca85475bba5747502eb036d3c18bd15aa`.
Each cell below is frame completion **p50 / p95 in milliseconds**, from 30
measured frames after five warm-up frames. No additional CPU quota or explicit
CPU affinity was applied to this benchmark container.

| Synthetic update | 2 workers | 4 workers | 8 workers | 22 workers |
| --- | ---: | ---: | ---: | ---: |
| Small text | 0.606 / 0.810 | 0.475 / 0.787 | 0.595 / 0.726 | 0.592 / 0.734 |
| Text scrolling | 10.525 / 11.901 | 6.285 / 8.359 | 5.289 / 5.851 | 10.922 / 12.472 |
| Mixed 4K desktop | 63.326 / 67.754 | 36.319 / 45.326 | 25.547 / 35.884 | 22.022 / 25.691 |
| 4K wallpaper, WebP | 153.116 / 189.681 | 80.316 / 86.585 | 49.511 / 51.181 | 39.338 / 44.482 |

Eight workers completed text scrolling fastest and used 32.822 ms of process CPU
time per frame, compared with 135.833 ms at 22 workers. Twenty-two workers
completed the large 4K updates fastest. For wallpaper updates, that improvement
required more CPU time (489.321 versus 329.765 ms per frame) and peak resident
memory (48,796 versus 21,864 KiB) than eight workers.

The differing workloads do not establish one best worker count. Automatic
selection and Oberon's configuration remain unchanged. These are synthetic
encoding results from one run, subject to host scheduling and the separate
benchmark wakeup barrier described above. They do not demonstrate a browser,
input-latency, or Wi-Fi improvement. The complete sanitized measurements,
including CPU, memory, and byte counts, are in
[`releases/1.6.1-private.4-encoder-benchmark.json`](../releases/1.6.1-private.4-encoder-benchmark.json).

## Workload-aware admission and production-path comparison

The persistent pool and `GUAC_DISPLAY_WORKER_THREADS` continue to set the
maximum number of encoders available to a session. Workload-aware admission
can use fewer of those existing threads for a frame; it does not create and
destroy pools, drop drawing operations, change image quality, or alter frame
boundaries.

The policy admits at most twelve simultaneous image encoders when
the final encoded image area is below 4,194,304 pixels and below half of the
committed desktop area. The limit also cannot exceed the real pool or the
number of image operations. Large changes, full-window transitions on smaller
desktops, and unknown desktop dimensions retain the full pool. Copy/fill
operations do not count toward image area. These are bounds on encoding work,
not limits on remote capture rate or browser frame rate.

Admission happens before a worker removes an operation from the production
FIFO or takes a framebuffer lock. The limit is selected only between frames,
under the FIFO lock, and stays fixed until that frame completes. Completing a
worker wakes a capacity waiter; invalidating the FIFO wakes all waiters during
shutdown. Partial pools use only successfully created threads. TRACE records
report the selected limit, real pool size, image count and encoded pixel area,
without retaining screen contents.

The earlier codec benchmark used a separate wakeup barrier and is insufficient
to validate this scheduling change. Compare the old library, the candidate
with a fixed full pool, and the candidate with workload-aware admission using
the real display path instead:

```sh
python3 scripts/benchmark-display-production.py \
    --baseline-image guacamole-private/native-benchmark:1.6.1-private.5 \
    --candidate-image guacamole-private/native-benchmark:1.6.1-private.6 \
    --samples 30 --warmup 5 > display-production-result.json
```

Repeat with `--reverse` to check mode-order bias. `--workers` fixes the same
pool size for every comparison (default 22); `--cpuset-cpus` optionally fixes
affinity. The candidate's private benchmark control affects subsequent frames
only and is not exposed through the Guacamole protocol or connection settings.
For shorter adjacent text comparisons, select
`--cases scroll-text partial-text-redraw` and
`--modes baseline fixed adaptive fixed baseline adaptive`. Explicit
`adaptive-8`, `adaptive-12` and `adaptive-16` modes support controlled tuning.

The harness updates synthetic layers through the real raw-context and frame
completion APIs. It includes dirty detection, every planner pass, copy search,
the production FIFO, actual encoding workers/codecs, frame completion, and
serialization to a shared discard socket. It measures a small text update,
translated text scrolling, partial text redraw, mixed 4K content, a 4K wallpaper
change, photo-heavy full-window changes at 1920×944 and 2560×1304, and smaller
photo windows within a 4K desktop. Fixture generation and initial
pool/allocation setup are excluded from measured wall
and CPU time. Each case uses a fresh process for separate peak-memory results;
containers have no network or production configuration access.

Report frame p50/p95, CPU time, bytes and memory for all cases. Compare the
candidate's fixed mode to the old library to expose admission overhead, then
compare its adaptive mode to both. The initial target was at least
15% better scrolling p95 without more than 5% regression on full-screen and
full-window updates. Production-path measurements did not demonstrate that
latency improvement, so this policy is an efficiency tradeoff rather than a
claim of faster window switching. Do not infer success from the old isolated
codec result. These synthetic fixtures do not measure capture, RDP transport,
browser painting, Wi-Fi, or physical input delay.

## Admission measurements, 15 October 2026

Thirty-frame production-path sweeps (five warm-up frames) found that the
initial eight-worker cap reduced scrolling/text-redraw CPU use but could
increase frame completion latency. Forward/reverse full sweeps also showed
host/mode-order variation. Follow-up sweeps interleaved fixed-pool runs with
caps of eight, twelve and sixteen. Twelve was selected as a more conservative
CPU/latency tradeoff than eight; sixteen saved little CPU in those fixtures.

Final verification compared the private.5 library from source
`f710301dfa278fc70268cd19dc6d3a14809603f4` with committed private.6 source
`6b8b0c25e175afd144cbd42630e29bb0c0294f3f`. It ran all nine scenarios in both
mode orders, then a shorter balanced text sequence. The latter used baseline,
fixed, adaptive, fixed, baseline, adaptive order, with both text workloads per
mode. Fixed and adaptive use the same private.6 library; fixed retains full-pool
admission. Each table value below is the **arithmetic mean of two per-run
summaries**, not a percentile computed from pooled frame samples:

| Workload | Mode | Mean reported p50 ms | Mean reported p95 ms | Mean CPU ms/frame |
| --- | --- | ---: | ---: | ---: |
| Text scrolling | private.5 | 38.614 | 43.592 | 114.052 |
| Text scrolling | private.6 fixed | 38.702 | 41.325 | 111.464 |
| Text scrolling | private.6 default twelve | 40.352 | 43.576 | 105.033 |
| Partial text redraw | private.5 | 36.390 | 38.713 | 97.870 |
| Partial text redraw | private.6 fixed | 36.721 | 39.007 | 100.651 |
| Partial text redraw | private.6 default twelve | 37.525 | 39.446 | 94.550 |

Against private.5, default admission used approximately 8% less process CPU
for scrolling and 3% less for partial redraw. Mean reported p95 was essentially
unchanged for scrolling and approximately 2% higher for redraw; mean reported
p50 was approximately 5% and 3% higher, respectively. This is a modest CPU
efficiency tradeoff, not a demonstrated native latency speedup. The original
15% scrolling-latency target was not met.

The first final full sweep alone showed a 7–8% text p95 increase, while the
reverse sweep showed a 2–3% decrease. That mode-order variation prompted the
balanced text check instead of selecting the favorable run. Across the two
full sweeps, mean reported p95 for each large/full-window workload was within
5% of the baseline or lower. Many of those workloads intentionally keep full
concurrency, so favorable variation is not attributed to the admission policy.

The photo-window checks demonstrate why selection uses the planner's final
image area, not the raw incoming dirty rectangle. A 2560×1304 photo update
inside a 3840×2160 desktop produced 15 image operations covering a summed
5,632,000 pixels after planning/combining. That exceeds the four-megapixel
guard, so all adaptive test caps selected 15 workers (the available image
count). A 1920×944 update produced eight image operations covering 2,623,488
pixels; its eight-worker limit was bounded by available work even with the
twelve/sixteen test caps. These cases did not force a photo-heavy batch down
to twelve workers from a larger useful count.

The complete candidate sweeps, tuning and photo-check results are preserved in
[`1.6.1-private.6-admission-benchmark.json`](../releases/1.6.1-private.6-admission-benchmark.json).
The final committed-source forward, reverse and balanced-text records, source
provenance, image IDs and numeric summaries are in
[`1.6.1-private.6-display-production-benchmark.json`](../releases/1.6.1-private.6-display-production-benchmark.json).
The old library reports zero admission/plan metadata because these counters
are unavailable there; those zeros do not mean it performed no rendering or
encoding. Real desktop/Wi-Fi acceptance remains separate.
