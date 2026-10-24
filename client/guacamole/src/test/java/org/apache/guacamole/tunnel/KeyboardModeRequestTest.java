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

package org.apache.guacamole.tunnel;

import java.util.Collections;
import java.util.List;
import org.apache.guacamole.GuacamoleClientException;
import org.apache.guacamole.protocol.GuacamoleClientInformation;
import org.junit.Assert;
import org.junit.Test;

/** HTTP/WebSocket request validation and optional client-info propagation. */
public class KeyboardModeRequestTest {
    private TunnelRequest request(final String mode) {
        return new TunnelRequest() {
            public String getParameter(String name) {
                if (name.equals(KEYBOARD_MODE_PARAMETER)) return mode;
                if (name.equals("hostname")) return "untrusted-host-override.invalid";
                return null;
            }
            public List<String> getParameterValues(String name) {
                String value = getParameter(name);
                return value == null ? null : Collections.singletonList(value);
            }
        };
    }

    @Test
    public void acceptsResolvedModesAndOlderBrowsers() throws Exception {
        TunnelRequestService service = new TunnelRequestService();
        for (String mode : new String[] { "windows", "mac", "physical", null, "" }) {
            GuacamoleClientInformation info = service.getClientInformation(request(mode));
            Assert.assertEquals(mode == null || mode.isEmpty() ? null : mode, info.getKeyboardMode());
        }
    }

    @Test
    public void rejectsUnsupportedModesWithoutEchoingInput() throws Exception {
        TunnelRequestService service = new TunnelRequestService();
        for (String invalid : new String[] { "auto", "MAC", " mac", "mac\n", "hostname=other", "0x474D0102" }) {
            try {
                service.getClientInformation(request(invalid));
                Assert.fail("Unsupported mode accepted");
            }
            catch (GuacamoleClientException expected) {
                Assert.assertEquals("Unsupported keyboard mode.", expected.getMessage());
            }
        }
    }
}
