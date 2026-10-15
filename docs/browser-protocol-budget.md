# Bounded browser protocol processing

Private.5's display scheduler yields while draining an existing rendering
queue, but each new flush starts a fresh budget. A single WebSocket message
containing many independently ready copy/fill/sync instructions can therefore
run their parsing and drawing synchronously for substantially longer than
eight milliseconds. Input and other browser tasks must wait for that message
handler to finish.

The WebSocket receive path now uses a connection-scoped `InstructionPump`.
It runs an isolated update immediately and yields through `MessageChannel`
after eight milliseconds or 4096 instructions. A timer is a compatibility
fallback if channel construction/posting is unavailable. Parsing also checks
its budget every 32 elements within a large instruction. Instructions are
delivered only when complete, and display frames retain their existing atomic
drawing behavior. A single element or callback can exceed eight milliseconds;
this is a cooperative budget, not a hard deadline.

`Parser.receive()` remains synchronous, including HTTP streaming responses and
session-recording consumers. The opt-in `receivePartial()` interface preserves
parser offsets when pausing. The pump prevents reentrant parsing, maintains
wire and acknowledgement order, and cancels old socket, timer, and channel
callbacks on disconnect/reconnect. Network activity timers reset when messages
arrive, before deferred parsing; internal keepalive data retains its transport
behavior. Natural WebSocket EOF drains already-received complete instructions
before terminal notification. Manual disconnect or reconnect cancels that drain
immediately, and no outgoing messages are attempted after EOF.

## Receive limits

The application receive queue permits at most 4096 pending messages and a
conservative 64 Mi-code-unit budget for source text, retained instruction
elements, and estimated element metadata. One incomplete instruction may
retain at most 16,384 elements; empty arguments count toward this independent
bound. Overflow closes the connection with an explicit receive-buffer error,
rather than discarding dependent instructions and continuing from invalid
state. Parser, queued packets, timers, and channel ports are released.

These limits apply to application receive buffering. They are not exact heap
measurements and do not bound browser-owned network buffers, decoder buffers,
or images already assigned to the display. UTF-16 lengths differ from wire
bytes for non-ASCII data, and shared substrings may be counted twice.

## Reproducing the comparison

```sh
node scripts/benchmark-browser-protocol.mjs --samples 4 --output result.json
```

This reuses the existing isolated Chrome launcher. Node.js 22 or newer and an
installed Chrome/Chromium are required; use `--browser` or `CHROME_BIN` if
automatic discovery fails. The browser keeps its normal sandbox and uses a
temporary profile with loopback-only debugging. No live desktop, credentials,
tunnel, or deployed configuration is used.

The replay compares the exact private.5 tagged common-js modules with the
working-tree modules. Each receives one synthetic WebSocket text burst through
the actual tunnel, parser, client, and display code. Canvas copies and fills
run normally, without injected drawing delays. Every sync acknowledgement is
checked for order and the final canvas pixel is validated. A separate posted
browser task measures when other work can run. Four samples alternate version
order. Source hashes and individual measurements are retained in
[`1.6.1-private.6-browser-protocol-benchmark.json`](../releases/1.6.1-private.6-browser-protocol-benchmark.json).

| Burst | Private.5 completion | New completion | Private.5 other-task delay | New other-task delay |
| --- | ---: | ---: | ---: | ---: |
| 22,000 small copy frames | 77.45 ms | 90.35 ms | 78.30 ms | 9.15 ms |
| 6,000 window copy frames | 56.50 ms | 61.70 ms | 58.45 ms | 9.30 ms |
| 3,000 mixed 1080p frames | 65.05 ms | 68.50 ms | 67.20 ms | 9.80 ms |

These are foreground headless Chrome medians. The receive budget substantially
reduces task blocking in these large bursts while adding approximately 5–17%
to backlog completion time. It is a responsiveness tradeoff, not a throughput
speedup. Tiny bursts below the budget are handled synchronously. The fixture
does not measure physical input latency, completed display paint/FPS, live
networking, Wi-Fi, image decoding, or background-tab throttling. Its bursts are
deliberately large and do not establish how frequently this condition occurs
in a live session.
