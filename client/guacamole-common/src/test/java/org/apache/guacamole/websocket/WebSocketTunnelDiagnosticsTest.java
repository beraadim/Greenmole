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

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class WebSocketTunnelDiagnosticsTest {
    @Test
    public void enablesOnlyExactTrustedSettingWithPropertyPrecedence() {
        assertFalse(WebSocketTunnelDiagnostics.enabled(null, null));
        assertFalse(WebSocketTunnelDiagnostics.enabled(null, "true"));
        assertFalse(WebSocketTunnelDiagnostics.enabled("0", "1"));
        assertFalse(WebSocketTunnelDiagnostics.enabled("", "1"));
        assertFalse(WebSocketTunnelDiagnostics.enabled("1 ", null));
        assertTrue(WebSocketTunnelDiagnostics.enabled(null, "1"));
        assertTrue(WebSocketTunnelDiagnostics.enabled("1", "0"));
    }

    @Test
    public void recordsNumericStagesAndBoundsReporting() {
        List<String> reports = new ArrayList<>();
        WebSocketTunnelDiagnostics stats = new WebSocketTunnelDiagnostics(() -> 0L, reports::add);
        stats.syncAck();
        stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 0, 2500, 12, true);
        stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 0, 5500, 20, false);
        assertArrayEquals(new long[] {2, 7, 5, 32, 1},
                stats.snapshot(WebSocketTunnelDiagnostics.Stage.SEND));
        assertEquals(0, reports.size());
        stats.record(WebSocketTunnelDiagnostics.Stage.READ, 0, 10000000000L, 0, true);
        assertEquals(1, reports.size());
        assertTrue(reports.get(0).startsWith("WebSocket diagnostics: connection=0 sync_ack=1"));
        assertTrue(reports.get(0).contains("SEND_count=2 total_us=7 max_us=5 chars=32 failures=1"));
        for (long now = 10000000001L; now < 10000100000L; now++)
            stats.record(WebSocketTunnelDiagnostics.Stage.READ, now, now, 0, true);
        assertEquals(1, reports.size());
        stats.record(WebSocketTunnelDiagnostics.Stage.READ, 0, 20000000000L, 0, true);
        assertEquals(2, reports.size());
    }

    @Test
    public void saturatesCountersAndIgnoresClockReversalAndStoppedWork() {
        List<String> reports = new ArrayList<>();
        WebSocketTunnelDiagnostics stats = new WebSocketTunnelDiagnostics(() -> 0L, reports::add);
        for (int i = 0; i < 1100; i++)
            stats.record(WebSocketTunnelDiagnostics.Stage.WRITE, 0, Long.MAX_VALUE, Long.MAX_VALUE, true);
        long[] snapshot = stats.snapshot(WebSocketTunnelDiagnostics.Stage.WRITE);
        assertEquals(Long.MAX_VALUE, snapshot[1]);
        assertEquals(Long.MAX_VALUE, snapshot[3]);
        snapshot[0] = -1;
        assertEquals(1100, stats.snapshot(WebSocketTunnelDiagnostics.Stage.WRITE)[0]);
        stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 1000, 999, -1, false);
        assertArrayEquals(new long[] {1, 0, 0, 0, 1}, stats.snapshot(WebSocketTunnelDiagnostics.Stage.SEND));
        stats.stop();
        stats.syncAck();
        stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 0, Long.MAX_VALUE, 100, true);
        assertArrayEquals(new long[] {1, 0, 0, 0, 1}, stats.snapshot(WebSocketTunnelDiagnostics.Stage.SEND));
        assertEquals(1, reports.size());
    }

    @Test
    public void failingDiagnosticOutputDisablesOnlyTelemetry() {
        WebSocketTunnelDiagnostics stats = new WebSocketTunnelDiagnostics(() -> 0L,
                ignored -> { throw new IllegalStateException("Injected logger failure"); });
        stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 0, 10000000000L, 12, true);
        assertArrayEquals(new long[] {1, 10000000, 10000000, 12, 0},
                stats.snapshot(WebSocketTunnelDiagnostics.Stage.SEND));
        stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 0, 20000000000L, 100, false);
        assertEquals(1, stats.snapshot(WebSocketTunnelDiagnostics.Stage.SEND)[0]);
    }

    @Test
    public void concurrentDirectionsShareBoundedCounters() throws InterruptedException {
        WebSocketTunnelDiagnostics stats = new WebSocketTunnelDiagnostics(() -> 0L,
                ignored -> fail("No report before deadline"));
        Thread[] threads = new Thread[4];
        for (int index = 0; index < threads.length; index++) {
            threads[index] = new Thread(() -> {
                for (int i = 0; i < 1000; i++) {
                    stats.syncAck();
                    stats.record(WebSocketTunnelDiagnostics.Stage.SEND, 0, 1000, 5, true);
                }
            });
            threads[index].start();
        }
        for (Thread thread : threads) thread.join();
        assertArrayEquals(new long[] {4000, 4000, 1, 20000, 0},
                stats.snapshot(WebSocketTunnelDiagnostics.Stage.SEND));
    }
}
