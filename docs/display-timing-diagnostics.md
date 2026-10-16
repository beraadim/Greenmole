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
Private.9 replaces the per-image `pthread_once`/`pthread_getspecific` lookup with
a compiler-managed thread-local pointer where supported. Configure compile-links
a pointer using `_Thread_local`, then `__thread`, under the requested compiler
flags and strict warnings. The test never runs a target executable, preserving
cross-compilation. Its temporary warnings do not change the caller's `CFLAGS`.
Reading, binding, and clearing that pointer need no pthread operation or heap
allocation. The disabled path still has the thread-local lookup per image and
an inline null-sample branch per blob; it is not zero overhead. Matched
production-path benchmarks must establish its effect on frame latency and CPU.

Other compilers retain the portable pthread backend. An enabled worker allocates
at most one small slot for its thread lifetime; the pthread key frees it at
thread exit. A scope changes a pointer inside that slot, so clearing it does not
call a fallible TLS setter. On either backend the sample belongs to the worker's
synchronous encoder scope and cannot be inherited by another thread. A failed
fallback TLS allocation/installation or clock read invalidates diagnostic
snapshots and logs one warning instead of presenting partial timings as complete.
Such a failure does not abort a frame or alter its encoded data. Neither backend
changes codec/quality selection, counter definitions, or encoded bytes.

The diagnostics tests run the same numeric, clock-failure, thread-isolation,
payload, and bounded-log checks against the selected backend and a forced pthread
copy. The latter also injects slot allocation/installation failures and verifies
that clearing remains infallible. For a whole-library fallback build, configure
with `guac_cv_thread_local=no`; this is a build-time cache override, not a runtime
setting.

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


## Optional sync and bridge diagnostics (private.12)

The existing native opt-in also enables a small aggregate per user at user
allocation. `GUAC_DISPLAY_DIAGNOSTICS=1` and guacd DEBUG logging produce
`Sync diagnostics` summaries during inbound sync activity, at most once every
ten seconds per user. No extra native diagnostic clock read is introduced:
the existing sync handler supplies its server timestamp. Removing the setting
and creating a new process/session disables collection. Allocation failure
only disables this optional aggregate. Displays retain their existing worker
statistics and independent logging interval.

The sync summary is cumulative: advancing, duplicate and stale ACK counts;
advancing-ACK age sum/maximum; existing estimated RTT/processing-lag maxima;
and maximum sent-timestamp minus acknowledged-timestamp span. The last is a
server-timeline backlog indicator, not a count of pending frames or bytes.
Only strictly advancing ACKs contribute timings. ACK ages use the echoed
server timestamp and the server clock; they include upstream serialization,
Java forwarding, network and browser processing and are not network RTT alone.
No browser clock is subtracted. The existing lag estimator is unchanged for
normal ACKs; very old ages now saturate integer fields instead of narrowing or
overflowing. Malformed, negative, overflowing, missing or extra sync timestamp
arguments are rejected. Valid duplicate/stale callbacks preserve existing
behavior. Guacd process/client context distinguishes separate connections;
these numeric per-user lines do not distinguish viewers sharing one connection.

For the standard JSR-356 Java WebSocket endpoint (the shipped Tomcat image),
set trusted process environment `GUAC_WEBSOCKET_DIAGNOSTICS=1`, or JVM property
`-Dguacamole.websocket-diagnostics=1`, before starting the web process. A present
JVM property takes precedence, including a value that disables collection.
Only exact `1` enables it. Configuration is sampled once when the class loads;
no message or connection argument can enable diagnostics. Enable DEBUG for
`org.apache.guacamole.websocket.GuacamoleWebSocketTunnelEndpoint` in the
existing logging configuration to see summaries. These settings are optional
operator actions, not additions to the release's production Compose settings.
Legacy Jetty-specific tunnel endpoints and the HTTP tunnel are not instrumented.

Java summaries contain an anonymous process-local numeric connection ordinal,
`sync_ack` (parsed inbound sync instructions, including attempts that later fail),
and these cumulative stage values: count, total/max microseconds, UTF-16 character
count and failed-attempt count. Ordinals never wrap/reuse; theoretical ordinal
exhaustion disables diagnostics for new endpoints. Clock differences use only
`System.nanoTime()` inside this JVM.

| Stage | Meaning / limit |
| --- | --- |
| `READ` | Native reader call duration, including normal idle waiting and final EOF/failed attempts; high values alone do not imply a stall |
| `BUFFER` | First append until the existing batch is offered for sending; includes subsequent reads/availability checks, excludes send-lock and socket send |
| `SEND_LOCK` | Waiting for the existing Java WebSocket send monitor |
| `SEND` | Synchronous `sendText()` call duration, including ping responses; return does not prove browser receipt |
| `WRITE_LOCK` | Waiting for the existing tunnel writer lock |
| `WRITE` | Incoming character conversion/filtering/guacd write, including internal ping handling and writer release; counts attempted message characters |

The Java helper retains six fixed aggregates and no per-frame records, payloads,
addresses, identifiers, configuration or protocol argument values. Reports are
activity-driven, at most one per ten seconds per endpoint. Closing stops
collection without forcing a partial report. An unexpected runtime failure from
the diagnostic logger disables only that endpoint's collection; it cannot
interrupt normal protocol forwarding or retain its writer lock. Native/Java counters saturate;
clock reversals clip negative duration samples to zero. Default Java collection
is null/disabled and adds no per-endpoint diagnostic allocation, clock reads or
parsing.
Global DEBUG logging may also show unrelated pre-existing Guacamole messages;
the new summaries themselves contain numeric measurements only.

### Local browser opt-in

An embedded application holding its `Guacamole.Client` can call
`client.setPipelineDiagnosticsEnabled(true)` and read
`client.getPipelineStatistics()`. The helper is bundled automatically by the
standard JavaScript build. Custom bundles may omit `PipelineDiagnostics.js`:
enabling then returns false and ordinary client behavior is unchanged.

In the standard Guacamole web app, an operator can run this in browser developer
tools while one remote session is focused. It selects the existing managed
client locally without printing the map's connection identifiers:

```javascript
var diagnosticManagedClients = Object.values(angular.element(document.documentElement)
    .injector().get('guacClientManager').getManagedClients());
var diagnosticFocusedClients = diagnosticManagedClients.filter(function(managed) {
    return managed.clientProperties.focused;
});
if (diagnosticFocusedClients.length !== 1)
    throw new Error('Focus exactly one remote session before collecting timing.');
var diagnosticClient = diagnosticFocusedClients[0].client;
diagnosticClient.setPipelineDiagnosticsEnabled(true);
```

Reproduce the pause, then read `diagnosticClient.getPipelineStatistics()`.
Finish with `diagnosticClient.setPipelineDiagnosticsEnabled(false)` and clear the
three diagnostic references when done. Enabling/disabling is local and immediate,
with no persistence, timer, logging, remote control or network instructions.
Disabled reads return null; a fresh enable starts fresh totals. Reconnect/stop/state import
cancels outstanding sample tokens so late callbacks cannot update a later
connection's timings. Custom application code must continue using the existing
client disconnect path when closing a connection.

The fresh numeric snapshot reports sync instruction receipts/completions, ACK
attempts, duplicate completions, canceled pending syncs, current/maximum in-flight
syncs, summed/maximum local sync-receipt-to-ACK-attempt time, maximum local
sync-arrival gap, sampled pending-frame/oldest-frame-age maxima and blocked-queue
sample count. Timing ends immediately before the existing `sendMessage('sync')`
attempt and includes display readiness/drawing and audio synchronization. It
proves neither successful delivery nor physical screen paint. A duplicate sync
can complete without sending another ACK. Queue sampling is at sync receipt and
completion, not continuous; it excludes unframed tasks/currently executing work,
and existing oldest-frame age uses the display's wall clock. Local intervals use
`performance.now()` where available, falling back to the local wall clock with
negative samples clipped. Numbers saturate at JavaScript's largest exact integer;
only fixed aggregates and tokens already held by pending display callbacks exist.

Use the three independent stage summaries for the same reproducible activity
and short interval. They cannot be subtracted across hosts or matched frame by
frame: no added wire data correlates timestamps, no synchronized clocks are
assumed, and cumulative lifetime maxima cannot be differenced. High native ACK
age with low local browser completion time and low Java sends suggests looking
at network/upstream pacing; it does not prove packet loss. A high browser in-flight
count/local completion maximum points to its receive/render/audio work. Compare
matched diagnostics-off controls before claiming performance gains: optional
instrumentation adds observer overhead.
