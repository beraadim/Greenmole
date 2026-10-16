/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.guacamole.websocket;

import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import org.slf4j.Logger;

/**
 * Optional bounded, numeric-only per-WebSocket stage totals. Configuration is
 * trusted process configuration, sampled once at class initialization. There
 * are no timers, message parsing, per-frame history or protocol extensions.
 */
final class WebSocketTunnelDiagnostics {

    enum Stage { READ, BUFFER, SEND_LOCK, SEND, WRITE_LOCK, WRITE }
    private static final long INTERVAL_NS = 10000000000L;
    private static final boolean ENABLED = configured();
    private static final class Ordinals {
        private static final AtomicLong NEXT = new AtomicLong();
    }
    private final long ordinal;
    private final long[][] values = new long[Stage.values().length][5];
    private final LongSupplier clock;
    private final Consumer<String> output;
    private long lastReport;
    private long syncAcks;
    private boolean stopped;

    private static boolean configured() {
        try {
            String property = System.getProperty("guacamole.websocket-diagnostics");
            return enabled(property, property == null
                    ? System.getenv("GUAC_WEBSOCKET_DIAGNOSTICS") : null);
        }
        catch (SecurityException denied) { return false; }
    }

    static boolean enabled(String property, String environment) {
        return "1".equals(property != null ? property : environment);
    }

    static WebSocketTunnelDiagnostics create(Logger logger) {
        if (!ENABLED) return null;
        long previous;
        do {
            previous = Ordinals.NEXT.get();
            // Never wrap or reuse an ordinal, even at the theoretical limit.
            if (previous == Long.MAX_VALUE) return null;
        } while (!Ordinals.NEXT.compareAndSet(previous, previous + 1));
        return new WebSocketTunnelDiagnostics(System::nanoTime,
                message -> logger.debug(message), previous + 1);
    }

    WebSocketTunnelDiagnostics(LongSupplier clock, Consumer<String> output) {
        this(clock, output, 0);
    }

    private WebSocketTunnelDiagnostics(LongSupplier clock, Consumer<String> output, long ordinal) {
        this.ordinal = ordinal;
        this.clock = clock;
        this.output = output;
        lastReport = clock.getAsLong();
    }

    long now() { return clock.getAsLong(); }

    private static long add(long a, long b) {
        return Long.MAX_VALUE - a < b ? Long.MAX_VALUE : a + b;
    }

    synchronized void syncAck() {
        if (!stopped) syncAcks = add(syncAcks, 1);
    }

    /** All durations use only nanoTime differences from this JVM. */
    synchronized void record(Stage stage, long start, long end, long chars, boolean success) {
        if (stopped) return;
        long[] totals = values[stage.ordinal()];
        long elapsed = end - start;
        long micros = elapsed >= 0 ? elapsed / 1000 : 0;
        totals[0] = add(totals[0], 1);
        totals[1] = add(totals[1], micros);
        totals[2] = Math.max(totals[2], micros);
        totals[3] = add(totals[3], Math.max(0, chars));
        if (!success) totals[4] = add(totals[4], 1);

        // Activity-driven, at most once per ten seconds. Closing does not force
        // a second partial report and no idle timer or logger thread exists.
        if (end - lastReport >= INTERVAL_NS) {
            lastReport = end;
            StringBuilder report = new StringBuilder("WebSocket diagnostics: connection=")
                    .append(ordinal).append(" sync_ack=").append(syncAcks);
            for (Stage measured : Stage.values()) {
                long[] data = values[measured.ordinal()];
                report.append(' ').append(measured.name()).append("_count=").append(data[0])
                    .append(" total_us=").append(data[1]).append(" max_us=").append(data[2])
                    .append(" chars=").append(data[3]).append(" failures=").append(data[4]);
            }
            output.accept(report.toString());
        }
    }

    synchronized void stop() { stopped = true; }

    /** Copy only, used by deterministic tests; never exposes mutable counters. */
    synchronized long[] snapshot(Stage stage) { return values[stage.ordinal()].clone(); }
}
