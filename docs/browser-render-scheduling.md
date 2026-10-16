# Browser render continuation benchmark

The private.4 browser scheduler preserved complete-frame drawing and allowed
input tasks to run during catch-up. It also resumed each slice through
`setTimeout(0)`. Repeated timer continuations incurred approximately four
milliseconds of additional delay per slice in the controlled Chrome replay.
Drawing and the associated sync acknowledgement both waited for that delay.
This made the same pending work take longer to finish even though other
browser tasks could run earlier.

The correction retains the eight-millisecond/sixteen-frame slice limits and
draws each individual frame atomically. It continues through a reusable
`MessageChannel`, which schedules a separate browser task without chaining
nested timers. An isolated ready frame still draws immediately. Browsers
without a usable channel retain the timer fallback. Cancellation closes both
ports; generation and channel-identity checks reject stale or duplicate
continuations when a display is reused.

## Reproducing the comparison

Run with Node.js 22 or later and a locally installed Chrome/Chromium:

```sh
node scripts/benchmark-browser-render.mjs --samples 4 --output result.json
```

If automatic browser discovery fails, pass `--browser` or set `CHROME_BIN`.
The script loads the exact tagged `Display.js` from private.3 and private.4,
and the actual current working-tree module. It records resolved revisions and
module SHA-256 values. Each version runs in alternating order to reduce order
bias. Chrome uses its normal sandbox, a temporary isolated profile, and a
loopback-only debugging endpoint. Temporary files and the browser are removed
afterward. No existing browser profile, live desktop, tunnel, clipboard,
credentials, or deployed configuration is used.

Each scenario queues complete frames behind one blocked image task, then
releases that task. A controlled amount of synchronous work stands in for
drawing each frame. The normal display scheduler and acknowledgement callbacks
run unchanged. A separate channel task is posted immediately before unblocking
the first frame to measure when other browser work gets a chance to run.

## Measurements

The sanitized private.5 record is
[`1.6.1-private.5-browser-render-benchmark.json`](../releases/1.6.1-private.5-browser-render-benchmark.json).
It includes every sample, browser version, source hashes, and completion,
acknowledgement-gap, and input-task-delay medians. Completion time and
input-task delay are separate measures: draining the queue quickly does not
guarantee that other browser work runs promptly.

This is a real-browser scheduler comparison with synthetic drawing costs.
It does not measure canvas throughput, physical input latency, a live RDP
connection, Wi-Fi, or background-tab throttling. A large backlog exaggerates
the repeated-timer effect compared with an isolated update. The result
identifies a regression in catch-up scheduling; it does not establish that
this was the only cause of a reported live-session slowdown.

## Regression coverage

The common-js scheduling suite exercises ordered drawing and acknowledgements,
complete-frame slices, blocked image completion, reentrancy, cancellation,
single-channel reuse, one outstanding continuation, stale/duplicate messages,
channel construction/posting failures, and timer fallback. The real-browser
case also verifies that another task runs between catch-up slices. These tests
cover scheduling behavior without asserting machine-specific elapsed times.

## Multi-image frame readiness

A frame must wait for every image before drawing or acknowledging any of its
tasks. Previously, each image's asynchronous completion retried readiness from
the start of the task array. Images completing in task order repeatedly scanned
the same ready prefix, producing quadratic predicate work for a large frame.
The frame now retains the index of its first unresolved task. Tasks only become
unblocked; they never become blocked again, and `flush()` gives each frame its
own fixed task array. Readiness can therefore advance this index without
skipping an unresolved task. A later completion still cannot overtake an
earlier frame, and cancellation discards the tasks and cursor together.

This changes readiness checks only. The eight-millisecond/sixteen-frame slice
limits, immediate rendering of isolated ready frames, complete-frame atomicity,
decode ownership, drawing order, and acknowledgement callbacks are unchanged.
There is no new production counter, clock, setting, or per-image allocation.

Run the separate comparison against the deployed private.9 implementation:

```sh
node scripts/benchmark-browser-render.mjs --scenario readiness \
  --baseline a3241ea675babc7e8f14ac33a7f15e7887a3379d \
  --samples 4 --output readiness.json
```

This explicit scenario leaves the existing render/protocol/timer fixtures
unchanged. Both versions run in alternating order with their resolved source
revisions and module hashes. It has two independent kinds of browser page:

- Count-only pages inject the same counter at the single blocked-task predicate
  in each source. Controlled deferred image callbacks complete in sequential,
  shuffled, or reverse order. The fixture verifies atomic drawing, original
  task order, and exactly one acknowledgement, then reports predicate reads.
  This instrumentation establishes structural work reduction, not elapsed speed.
- Timing pages load the unmodified source and stream actual PNG/WebP bytes
  through `InputStream`/`drawStream()` into native browser decoders and real
  canvases. Forty- and 128-image frames each have four warm-ups and 24 measured
  frames, with a target minimum 16 ms source interval and two delivery phases.
  Every frame verifies image counts, ordered acknowledgement callbacks, and
  exact decoded pixels against an independently decoded canvas oracle. WebP's
  oracle uses its decoded pixels, not the original pre-compression source.

Per-frame timing includes task/stream setup, staged local delivery, decoding,
drawing, and the acknowledgement callback. Oracle generation, pixel readback,
and pacing occur outside that timer; total replay duration includes those costs
and must not be interpreted as frame throughput. Observed source-gap quantiles
show the actual pacing, which can exceed its minimum when decoding/readback is
slower. A separately posted channel task measures an opportunity for other
browser work, not physical input. The summaries are medians of per-replay
quantiles, not pooled percentiles. Timing pages contain no predicate counter.

The benchmark requires identical frame/image counts, decoder choice, checked
pixels, and final pixel hashes across versions and samples. Count-only runs
also reject missing/invalid observations. Existing unit regressions add large
sequential and shuffled frames, later completed frames waiting on earlier ones,
pre-flush unblocks, decode failure, cancellation after a ready prefix, stale
callbacks reaching a reused display, duplicate callbacks, and cancellation
during an atomic draw. Existing scheduling/image suites continue to cover
reentrant flushes, resource ownership, and native decoder failures.

These are foreground headless-browser API and acknowledgement-callback
measurements. They do not measure physical display paint/FPS, wire ACKs, capture,
RDP transport, Wi-Fi, physical input, or background-tab throttling. Reduced
predicate work does not establish that readiness checks dominate a live client;
native decoding and canvas operations may hide the difference in elapsed time.
