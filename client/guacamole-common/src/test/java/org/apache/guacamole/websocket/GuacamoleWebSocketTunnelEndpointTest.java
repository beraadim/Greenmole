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

import java.io.StringWriter;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import javax.websocket.EndpointConfig;
import javax.websocket.RemoteEndpoint;
import javax.websocket.Session;
import org.apache.guacamole.GuacamoleException;
import org.apache.guacamole.GuacamoleServerException;
import org.apache.guacamole.io.GuacamoleWriter;
import org.apache.guacamole.io.WriterGuacamoleWriter;
import org.apache.guacamole.net.GuacamoleTunnel;
import org.apache.guacamole.net.SimpleGuacamoleTunnel;
import org.apache.guacamole.protocol.GuacamoleInstruction;
import org.junit.Test;
import static org.junit.Assert.*;

public class GuacamoleWebSocketTunnelEndpointTest {
    private static class Tunnel extends SimpleGuacamoleTunnel {
        final StringWriter output = new StringWriter();
        int acquired, released, failure;
        Tunnel() { super(null); }
        @Override public GuacamoleWriter acquireWriter() {
            acquired++;
            return new WriterGuacamoleWriter(output) {
                @Override public void writeInstruction(GuacamoleInstruction instruction)
                        throws GuacamoleException {
                    if (failure == 1) throw new GuacamoleServerException("Injected test failure");
                    if (failure == 2) throw new IllegalStateException("Injected runtime failure");
                    super.writeInstruction(instruction);
                }
            };
        }
        @Override public void releaseWriter() { released++; }
    }

    private GuacamoleWebSocketTunnelEndpoint endpoint(Tunnel tunnel,
            WebSocketTunnelDiagnostics diagnostics, List<String> sent) throws Exception {
        GuacamoleWebSocketTunnelEndpoint endpoint = new GuacamoleWebSocketTunnelEndpoint() {
            @Override protected GuacamoleTunnel createTunnel(Session session, EndpointConfig config) {
                return null;
            }
        };
        Field socket = GuacamoleWebSocketTunnelEndpoint.class.getDeclaredField("tunnel");
        socket.setAccessible(true);
        socket.set(endpoint, tunnel);
        Field timing = GuacamoleWebSocketTunnelEndpoint.class.getDeclaredField("diagnostics");
        timing.setAccessible(true);
        timing.set(endpoint, diagnostics);
        Field remote = GuacamoleWebSocketTunnelEndpoint.class.getDeclaredField("remote");
        remote.setAccessible(true);
        remote.set(endpoint, Proxy.newProxyInstance(getClass().getClassLoader(),
                new Class<?>[] { RemoteEndpoint.Basic.class }, (proxy, method, args) -> {
                    if (method.getName().equals("sendText")) sent.add((String) args[0]);
                    return null;
                }));
        return endpoint;
    }

    @Test public void preservesForwardingAndInternalPingWithOptionalTiming() throws Exception {
        for (boolean enabled : new boolean[] { false, true }) {
            Tunnel tunnel = new Tunnel();
            List<String> sent = new ArrayList<>();
            WebSocketTunnelDiagnostics timing = enabled
                    ? new WebSocketTunnelDiagnostics(() -> 1000L, ignored -> fail("No early log")) : null;
            GuacamoleWebSocketTunnelEndpoint endpoint = endpoint(tunnel, timing, sent);
            String sync = new GuacamoleInstruction("sync", "123").toString();
            String ping = new GuacamoleInstruction("", "ping", "321").toString();
            endpoint.onMessage(sync + ping + new GuacamoleInstruction("", "ignored").toString());
            assertEquals(sync, tunnel.output.toString());
            assertEquals(1, sent.size());
            assertEquals(ping, sent.get(0));
            assertEquals(1, tunnel.acquired);
            assertEquals(1, tunnel.released);
            if (timing != null) {
                assertEquals(1, timing.snapshot(WebSocketTunnelDiagnostics.Stage.WRITE)[0]);
                assertEquals(1, timing.snapshot(WebSocketTunnelDiagnostics.Stage.SEND)[0]);
                assertEquals(0, timing.snapshot(WebSocketTunnelDiagnostics.Stage.WRITE)[4]);
            }
        }
    }

    @Test public void releasesWriterAfterCheckedAndUnexpectedFailure() throws Exception {
        for (int failure : new int[] { 1, 2 }) {
            Tunnel tunnel = new Tunnel();
            tunnel.failure = failure;
            WebSocketTunnelDiagnostics timing = new WebSocketTunnelDiagnostics(() -> 1000L,
                    ignored -> fail("No early log"));
            GuacamoleWebSocketTunnelEndpoint endpoint = endpoint(tunnel, timing, new ArrayList<>());
            try {
                endpoint.onMessage(new GuacamoleInstruction("sync", "123").toString());
                assertEquals(1, failure); // The existing checked failure is logged and swallowed.
            }
            catch (IllegalStateException expected) { assertEquals(2, failure); }
            assertEquals(1, tunnel.acquired);
            assertEquals(1, tunnel.released);
            assertEquals(1, timing.snapshot(WebSocketTunnelDiagnostics.Stage.WRITE)[4]);
        }
    }
}
