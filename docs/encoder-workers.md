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
