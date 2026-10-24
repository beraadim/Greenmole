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

package org.apache.guacamole.protocol;

import java.io.StringReader;
import java.io.StringWriter;
import org.apache.guacamole.GuacamoleException;
import org.apache.guacamole.io.GuacamoleReader;
import org.apache.guacamole.io.GuacamoleWriter;
import org.apache.guacamole.io.ReaderGuacamoleReader;
import org.apache.guacamole.io.WriterGuacamoleWriter;
import org.apache.guacamole.net.GuacamoleSocket;
import org.junit.Assert;
import org.junit.Test;

/** Exercises the actual guacd handshake without sockets or desktop input. */
public class KeyboardModeHandshakeTest {
    private String handshake(String protocol, String configured, String browser,
            String... requested) throws GuacamoleException {
        final String input = new GuacamoleInstruction("args", requested).toString()
                + new GuacamoleInstruction("ready", "fixture").toString();
        final StringWriter output = new StringWriter();
        GuacamoleSocket socket = new GuacamoleSocket() {
            private final GuacamoleReader reader = new ReaderGuacamoleReader(new StringReader(input));
            private final GuacamoleWriter writer = new WriterGuacamoleWriter(output);
            public GuacamoleReader getReader() { return reader; }
            public GuacamoleWriter getWriter() { return writer; }
            public void close() { }
            public boolean isOpen() { return true; }
        };
        GuacamoleConfiguration config = new GuacamoleConfiguration();
        config.setProtocol(protocol);
        config.setParameter("hostname", "fixture.invalid");
        if (configured != null)
            config.setParameter("greenmole-keyboard-mode", configured);
        GuacamoleClientInformation info = new GuacamoleClientInformation();
        info.setKeyboardMode(browser);
        new ConfiguredGuacamoleSocket(socket, config, info);
        return output.toString();
    }

    @Test
    public void browserHintRequiresTheNamedOptionalRdpArgument() throws Exception {
        for (String mode : new String[] { "windows", "mac", "physical" }) {
            String actual = handshake("rdp", null, mode, "hostname", "greenmole-keyboard-mode");
            Assert.assertTrue(actual.contains(new GuacamoleInstruction("connect", "fixture.invalid", mode).toString()));
        }
        String legacy = handshake("rdp", null, "mac", "hostname");
        Assert.assertTrue(legacy.contains(new GuacamoleInstruction("connect", "fixture.invalid").toString()));
        Assert.assertFalse(legacy.contains("mac"));
    }

    @Test
    public void administratorChoiceWinsAndAutoUsesBrowser() throws Exception {
        for (String configured : new String[] { "windows", "mac", "physical", "invalid-config" }) {
            String actual = handshake("rdp", configured, "mac", "greenmole-keyboard-mode");
            Assert.assertTrue(actual.contains(new GuacamoleInstruction("connect", configured).toString()));
        }
        for (String configured : new String[] { null, "", "auto" }) {
            String actual = handshake("rdp", configured, "mac", "greenmole-keyboard-mode");
            Assert.assertTrue(actual.contains(new GuacamoleInstruction("connect", "mac").toString()));
        }
    }

    @Test
    public void missingHintAndOtherProtocolsReceiveNoExtension() throws Exception {
        for (String protocol : new String[] { "rdp", "vnc", "ssh" }) {
            String actual = handshake(protocol, null, protocol.equals("rdp") ? null : "mac", "greenmole-keyboard-mode");
            Assert.assertTrue(actual.contains(new GuacamoleInstruction("connect", "").toString()));
        }
    }

    @Test
    public void directClientInfoRejectsArbitraryOverrides() {
        GuacamoleClientInformation info = new GuacamoleClientInformation();
        for (String invalid : new String[] { "auto", "MAC", " mac", "mac\n", "hostname=other", "0x474D0102" }) {
            try {
                info.setKeyboardMode(invalid);
                Assert.fail("Unsupported mode accepted");
            }
            catch (IllegalArgumentException expected) { }
        }
        info.setKeyboardMode("mac");
        info.setKeyboardMode("");
        Assert.assertNull(info.getKeyboardMode());
    }
}
