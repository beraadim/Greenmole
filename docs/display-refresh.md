# Private display snapshot recovery

This fork adds a versioned `x-resync` extension. The RDP plugin advertises
`x-resync,1,ready` only after installing its authenticated per-user handler.
The browser never sends requests without that advertisement; older browsers
ignore it, and unsupported native protocols ignore requests.

A request is `x-resync,1,request`, with exact argument count, version and action
validation. The daemon permits at most one request per user every five seconds.
Malformed, unsupported and rate-limited requests are silently ignored. A valid
request resends the committed display state only to the requesting user's
socket, without injecting remote input or changing other users' views.
Read-only viewers can refresh the view they already have permission to see.

Recovery reuses the display's snapshot and serialization locks. The 250 ms
limit applies only to the render-state condition wait; snapshot lock
acquisition, PNG encoding and socket sending retain their existing behavior.
A busy/not-ready render returns `x-resync,1,busy`; a sent snapshot returns
`x-resync,1,done`. Refresh replaces pixels with SRC compositing so transparent
pixels erase stale contents, while initial joining keeps its existing behavior.

The browser releases a failed image task, counts the failure and requests a
snapshot after unwinding the draw stack. Failures from one burst share one
timer. Requests are separated by at least 5.5 seconds; automatic attempts stop
after three per connection. Manual **Display → Refresh display** remains
available with the same rate limit. A new connection forgets capability,
counters and pending retries. Network closure prevents further requests.

Queue depth, oldest queued frame age, blocked-image state, image failures and
refresh-request counts are available in the optional performance overlay.
Only numeric counters are retained, with no image or exception contents.
This repairs omitted image data after a decode failure; it does not establish
the cause of any previously observed stale desktop or recover a dead network.
