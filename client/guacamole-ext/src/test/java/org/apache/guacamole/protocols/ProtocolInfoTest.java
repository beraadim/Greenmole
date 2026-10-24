/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.guacamole.protocols;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import org.apache.guacamole.environment.LocalEnvironment;
import org.apache.guacamole.form.Field;
import org.apache.guacamole.form.Form;
import org.junit.Assert;
import org.junit.Test;

/** Verify the actual packaged protocol resource through the production loader. */
public class ProtocolInfoTest {

    @Test
    public void productionLoaderKeepsRdpWithAttributionMetadata() {
        ProtocolInfo rdp = LocalEnvironment.getInstance().getProtocols().get("rdp");
        Assert.assertNotNull("RDP must not disappear from the protocol schema", rdp);
        Assert.assertEquals("rdp", rdp.getName());
        Map<String, Field> fields = new HashMap<String, Field>();
        for (Form form : rdp.getConnectionForms()) {
            for (Field field : form.getFields())
                fields.put(field.getName(), field);
        }
        Assert.assertEquals(Arrays.asList("", "auto", "windows", "mac", "physical"),
                fields.get("greenmole-keyboard-mode").getOptions());
        Assert.assertTrue(fields.get("server-layout").getOptions().containsAll(
                Arrays.asList("en-us-qwerty", "no-no-qwerty", "nb-no-qwerty")));
    }

    @Test
    public void unrelatedUnknownProtocolFieldsRemainRejected() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String metadata = "\"_greenmoleModificationNotice\":\"fixture attribution\"";
        ProtocolInfo protocol = mapper.readValue("{\"name\":\"rdp\"," + metadata + "}", ProtocolInfo.class);
        Assert.assertEquals("rdp", protocol.getName());
        Assert.assertFalse(mapper.writeValueAsString(protocol).contains("_greenmoleModificationNotice"));
        try {
            mapper.readValue("{\"name\":\"rdp\"," + metadata + ",\"unexpectedProtocolField\":true}", ProtocolInfo.class);
            Assert.fail("Unrecognized protocol fields must remain errors");
        }
        catch (UnrecognizedPropertyException expected) {
            Assert.assertEquals("unexpectedProtocolField", expected.getPropertyName());
        }
    }
}
