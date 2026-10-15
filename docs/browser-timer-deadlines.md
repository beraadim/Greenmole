# Browser timer deadlines

Private.6 recreates the client keepalive timeout after every received
instruction. Its WebSocket transport recreates receive, unstable, and ping
timeouts after every raw message. The deadlines usually stay the same or move
later, so this creates timer work without changing when the next action is due.

The client and WebSocket transport now use one `DeadlineTimer` per role.
Scheduling the same or a later deadline retains the pending browser timeout.
When that timeout wakes, it checks the latest deadline and rearms only if
needed. An earlier deadline replaces the pending timeout immediately.
Cancellation invalidates callbacks already queued by the browser, including
after the timer is reused by another connection.

## Preserved connection behavior

- Client keepalive attempts remain due five seconds after the last attempt.
  Transport stability pings remain due 500 ms after the last attempt.
- Both retain their existing one-shot, activity-triggered scheduling policy.
  Firing a timer does not introduce a new continuous idle heartbeat policy.
- Incoming instructions or raw messages immediately send an overdue ping if
  its timer was delayed or throttled. A saved old callback cannot send it twice.
- Raw WebSocket arrival extends the receive and unstable deadlines before
  deferred parsing. Activity immediately clears the unstable state.
- Interval calculations use elapsed time where `performance.now()` is
  available. Wall-clock changes therefore do not alter these intervals; the
  timestamp carried in a transport ping remains a wall-clock timestamp.
- Disconnect, reconnect, natural EOF, and callback errors retain their
  cancellation behavior. Client instruction/state callbacks which replace a
  connection cannot recreate the old connection's timer afterward.
- The receive pump's eight-millisecond/4096-instruction policy, buffer limits,
  EOF draining, display-frame atomicity, image handling, and ACK ordering are
  unchanged. HTTP transport watchdogs retain their existing implementation;
  the shared client keepalive improvement also applies when HTTP is used.

The helper is included by the common-js build's existing `modules/**/*.js`
resource/minification pattern and the source-wide JSDoc input. It adds no
runtime dependency or deployed setting.

## Reproducing measurements

```sh
node scripts/benchmark-browser-timers.mjs --samples 4 --output timers.json
node scripts/benchmark-browser-protocol.mjs --baseline 1.6.1-private.6 --samples 4 --output protocol.json
```

Node.js 22 or newer and an installed Chrome/Chromium are required. Use
`CHROME_BIN` or `--browser` if automatic discovery fails. The existing launcher
keeps the browser sandbox enabled, isolates its temporary profile, and binds
debugging to loopback. No live desktop, credentials, network tunnel, or
deployed configuration is used.

Both replays compare exact private.6 tagged modules to the current production
modules, with alternating version order. They run the actual tunnel, parser,
client, and canvas copying/filling code. Every sync ACK is checked for order,
and final canvas pixels are verified. The records include source hashes,
individual samples, browser version, and completion/input-task medians:

- [`1.6.1-private.7-browser-timers-benchmark.json`](../releases/1.6.1-private.7-browser-timers-benchmark.json)
- [`1.6.1-private.7-browser-protocol-benchmark.json`](../releases/1.6.1-private.7-browser-protocol-benchmark.json)

The timer-count replay wraps native timeout APIs for both versions. That
instrumentation adds overhead, particularly to the version allocating many
timers, so the separate uninstrumented protocol run supplies the completion
comparison below. These are four-sample foreground headless Chrome medians:

| Burst | Private.6 completion | New completion | Private.6 other-task delay | New other-task delay |
| --- | ---: | ---: | ---: | ---: |
| 22,000 small copy frames | 88.90 ms | 78.50 ms | 9.00 ms | 9.15 ms |
| 6,000 window copy frames | 62.50 ms | 56.75 ms | 9.25 ms | 9.60 ms |
| 3,000 mixed 1080p frames | 71.25 ms | 61.55 ms | 13.05 ms | 9.10 ms |

Completion improved approximately 9–14% in this replay. These results do not
establish physical input latency, paint/FPS, Wi-Fi, image decoding, background
behavior, or the size of an improvement in a live RDP workload.

During the measured bursts, timer allocations/cancellations fell from
44,003/30,003/33,003 to zero, with four timeout roles already pending at the
start of each burst. A fourth timer-count case injects 1000 synthetic messages
containing 6,000 copy frames: allocations/cancellations fell from 33,000 to
zero. This fixture injects those messages in one browser task, unlike real
WebSocket delivery; its other-task delay is not a transport latency measure.
Zero new timers within these short bursts does not mean the connection uses
no timers: deadlines still wake, recheck activity, and rearm normally.

## Regression coverage

Focused controlled-clock tests cover repeated/later/earlier deadlines, queued
callback cancellation and reuse, one-shot idle behavior, overdue throttled
timers, wall-clock changes, updated receive/unstable thresholds, raw-arrival
timeout accounting, immediate recovery from unstable, EOF/reconnect cleanup,
connect failures, and instruction/state/send callback reentrancy. A progressing
1000-packet activity test creates five transport timeouts over one second,
including the scheduled pings, instead of reallocating three for every packet.
