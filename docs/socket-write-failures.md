# Socket write failure handling

The socket writer has two different return conventions: driver write handlers
return a byte count or `-1`, while `guac_socket_write()` and the Base64 helpers
return zero on success and a nonzero value on failure. A positive failure from
the generic writer must therefore stop Base64 flushing and instruction output.

The generic writer accepts positive partial writes and advances only by the
reported count. Negative results stop immediately. A zero result for nonempty
input, or a result larger than the requested count, reports an I/O error instead
of looping or moving outside the supplied buffer. Handler results remain
`ssize_t`; there is no intermediate `int` truncation. A failed Base64 flush clears
its attempted input because an encoded prefix may already have reached the
peer. The caller must abandon the failed instruction/socket, not retry it.

The fd driver keeps its existing terminal-error latch. A zero-byte write now
records `EIO`, and subsequent flushes/direct writes/buffered writes reject the
connection without resending its partial prefix. POSIX `EINTR` retries an
interrupted call with no reported bytes, and short successful writes advance
normally. Winsock `WSAEINTR`
receives the corresponding interrupted-call retry. System-call chunks and fd
handler results are bounded to `INT_MAX`; buffered chunk calculations use
`size_t`. `EAGAIN`/`EWOULDBLOCK` remain terminal: the current driver uses blocking
descriptors and does not implement a nonblocking readiness queue.

The TLS driver also latches its first write error under the existing connection
mutex. It clears the OpenSSL error queue before `SSL_write()`, captures errno,
and classifies unsuccessful results with `SSL_get_error()` in the same thread
while still holding that mutex. Every unsuccessful result becomes `-1` for the
generic writer, including OpenSSL's zero result. Close notifications report
`GUAC_STATUS_CLOSED`; syscall failures preserve a meaningful errno; other TLS
failures report an I/O error. Later writes restore the original failure without
calling OpenSSL again. Failed connections skip `SSL_shutdown()` during cleanup,
as that operation is forbidden after fatal OpenSSL errors. Socket/driver
allocation failures release the newly created SSL object.

The same latch prevents subsequent `SSL_read()`/`SSL_pending()` calls. Select
reports a latched error as immediately ready so the next read can report it
without waiting. The final read check is under the connection mutex, covering a
write failure between the initial readiness check and `SSL_read()`. Latching a
terminal error also shuts down descriptor I/O, waking a reader already blocked
in its peek wait; this does not perform further TLS I/O.

The secure-socket path already requires a successful blocking `SSL_accept()`.
`SSL_ERROR_WANT_READ`/`SSL_ERROR_WANT_WRITE` fail cleanly with an explicit
unsupported-retry error. They are **not** silently retried: safe retry support
would require the identical buffer and length, an explicit readiness/deadline
policy, and cancellation semantics. `SSL_ERROR_SYSCALL`, including an interrupted
syscall classified this way by OpenSSL, is treated as terminal rather than
blindly replaying TLS I/O. Lengths are bounded to `INT_MAX` before `SSL_write()`.
The [OpenSSL write documentation](https://docs.openssl.org/3.0/man3/SSL_write/)
defines its length/result/retry contract, and the
[OpenSSL error documentation](https://docs.openssl.org/3.0/man3/SSL_get_error/)
defines error-queue, threading and fatal-error requirements.

## Regression coverage

`server/src/libguac/tests/socket/write.c` verifies partial-write byte order,
zero/negative/excessive handler counts, immediate partial-failure return, RFC
4648 Base64 vectors and automatic-buffer boundaries, positive failure
propagation without encoded-prefix replay, and blob-instruction failure with
balanced instruction locking and no trailing terminator.

`socket/fd_write_failure.c` injects only the syscall boundary into the actual
driver. It covers short writes interrupted by signals, zero progress, partial
`EPIPE`/`EAGAIN`/missing-errno failures, sticky errors on every write path, and
failure while an automatic buffer flush still has more input pending.

`socket/ssl_write_failure.c` injects the OpenSSL boundaries into the actual TLS
driver. It verifies classification while the mutex is held and after clearing
the error queue, partial writes, safe length conversion, zero/WANT/fatal/syscall
results, first-error restoration, no prefix replay, no TLS shutdown after write
failure, and both Guacamole allocation-failure paths using a real SSL object.
It also covers a fatal/WANT failure before a read and a write failure between
the reader's readiness check and its final lock, including peek error/EOF/data
outcomes; none may perform a subsequent TLS read.
This test is registered only when SSL support is enabled and links OpenSSL
explicitly. Existing fd and nested-socket instruction tests verify successful
wire output through real pipes.

Run the normal native gate with a configured server build using `make check`.
These changes address failure-path correctness; they are not evidence of a
normal-throughput improvement or a diagnosis of previous live disconnects.
Fault tests do not substitute for a live TLS handshake/renegotiation or Windows
runtime test. No new timeout or nonblocking-I/O policy is introduced.
