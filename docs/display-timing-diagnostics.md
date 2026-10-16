# Optional display timing diagnostics

Private.8 adds numeric display-worker timing for investigating slow photo or
window updates while preserving the existing codec/quality policy. It does not
change lossless requests, image order, worker admission, or frame boundaries.
There is no evidence yet that codec hysteresis would improve these workloads;
format switching remains unchanged pending controlled fixed-quality results.

For a short diagnostic run, start guacd with `GUAC_DISPLAY_DIAGNOSTICS=1` in its
administrative environment and enable its existing DEBUG log level (`-L debug`).
Only the exact value `1` enables collection. The setting is read once when each
display is allocated, before workers start. Existing sessions are unaffected by
later environment changes. No browser/user codec setting is added. Remove the
environment variable and restart the diagnostic guacd process to disable it.
This is an optional operator workflow, not part of normal release deployment.

Each opted-in display emits one startup DEBUG message, then at most one numeric
cumulative summary every ten seconds, at a completed frame boundary. Idle
sessions do not schedule logging timers. The summary contains counts, timings,
and encoded-byte counts only: no image, clipboard, protocol argument, hostname,
or connection configuration contents. Enabling DEBUG can also enable existing
unrelated Guacamole messages; collection does not require global TRACE logging.

Collection is disabled by default, with no additional diagnostic clock reads.
The disabled codec path has one `pthread_once`/TLS lookup per encoded image and
an inline null-sample branch per blob; this is small work, not zero overhead.
An enabled worker allocates at most one small TLS slot for its thread lifetime.
The pthread key owns that slot and frees it at thread exit. A scope changes a
pointer inside the slot; ending it does not call a fallible TLS setter. A failed
TLS allocation/installation or clock read invalidates diagnostic snapshots and
logs one warning instead of presenting partial timings as complete. Such a
failure does not abort a frame or alter its encoded data.

## Private snapshot interface

`guac_display_get_render_statistics(display, values, count)` is an internal,
non-installed API. It returns `1` for an enabled, valid snapshot and requires
exactly sixteen `uint64_t` slots. A disabled display, invalid snapshot, null
argument, or wrong count returns `0` without modifying the output. Counters are
saturating and protected by the existing operation FIFO lock. Completed-image
and frame totals are published before the last worker decrements
`active_workers` to zero, allowing the production-path benchmark to sample after
its existing drain barrier. A caller sampling an active frame can see its
completed-image totals before its final frame counter advances.

| Slot | Name | Meaning |
| --- | --- | --- |
| 0 | images | Completed image operations |
| 1 | pixels | Sum of completed image rectangle areas |
| 2 | queue_us | Sum of batch-start-to-worker-admission wall durations |
| 3 | lock_wait_us | Sum of time spent acquiring the committed-frame read lock |
| 4 | format_us | Sum of image-format selection wall durations |
| 5 | stream_us | Sum of image stream wall durations, including interleaved protocol sends |
| 6 | blob_send_us | Nested subset of stream_us spent in image blob protocol sends |
| 7 | encoded_bytes | Encoded image bytes offered to blob sends, including failed attempts |
| 8 | png_images | Image operations selecting PNG |
| 9 | jpeg_images | Image operations selecting JPEG |
| 10 | webp_images | Image operations selecting WebP |
| 11 | frames | Completed worker frame boundaries |
| 12 | finish_us | Sum of cursor/sync/backing-copy/socket-flush wall durations |
| 13 | frame_elapsed_us | Sum of batch-start-to-final-flush wall durations |
| 14 | queue_max_us | Lifetime maximum image admission delay |
| 15 | stream_max_us | Lifetime maximum image stream wall duration |

All durations use microseconds. On systems with a monotonic clock, a failed
monotonic read returns an invalid sample; it never switches into the wall-clock
domain. Platforms without that facility use `gettimeofday()` consistently;
backwards durations clip to zero. The private enum in `display-diagnostics.h`
is the authoritative slot order.

The batch-start timestamp is taken when configuring a new worker batch, before
inline copy/fill instructions and queued image publication. Thus `queue_us`
also includes that publication/control-instruction work; it is not a pure FIFO
waiting timer. It excludes source batching and the five planning/snapshot
phases, which already have separate numeric benchmark captures. Lock waiting is
measured immediately around the committed-frame read-lock acquisition.

The image encoders stream compressed output through blob protocol sends during
encoding. `stream_us - blob_send_us` is a codec/serialization/socket-lock
residual, **not pure codec CPU time**. It also includes image/end instruction
handling and quality selection. Blob time includes protocol serialization,
fan-out, socket locking, and any blocking performed there. It is not a browser
paint/ACK measurement or a promise that bytes reached a remote client. Image
surface preparation/alpha clearing precede these two timers. Final-frame work
has its own `finish_us` timer. Worker sums overlap when encoders run in parallel,
so they must not be added to estimate frame latency. The final two slots are
lifetime gauges, including warm-up; subtracting them between frames is invalid.

Use [the production display benchmark](display-production-benchmark.md) with
its opt-in `--render-diagnostics` and fixed-codec/quality controls to compare
like-for-like work. Diagnostic-on timings include measurement overhead; the
normal default-off build still needs a separate matched performance control.
The harness treats an explicitly requested but invalid snapshot as a failure.
