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
