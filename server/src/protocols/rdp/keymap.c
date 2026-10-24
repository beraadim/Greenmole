/*
 * Modified for Greenmole by its maintainers.
 *
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

#include "keymap.h"

#include <string.h>

const guac_rdp_keymap* guac_rdp_keymap_find(const char* name) {

    /* Both historical Norwegian labels describe the same physical layout. */
    if (name == NULL)
        return NULL;
    if (strcmp(name, "nb-no-qwerty") == 0)
        name = "no-no-qwerty";

    /* For each keymap */
    const guac_rdp_keymap** current = GUAC_KEYMAPS;
    while (*current != NULL) {

        /* If name matches, done */
        if (strcmp((*current)->name, name) == 0)
            return *current;

        current++;
    }

    /* Failure */
    return NULL;

}


/* MS-RDPBCGR defines keyboardSubType as OEM-dependent. These exact values
 * describe Greenmole's virtual keyboard, not the client's hardware or locale.
 * The hint never changes outgoing scancodes or legacy graphics negotiation. */
UINT32 guac_rdp_keyboard_mode_subtype(const char* mode) {
    if (mode == NULL)
        return 0;
    if (strcmp(mode, "windows") == 0)
        return 0x474D0101;
    if (strcmp(mode, "mac") == 0)
        return 0x474D0102;
    if (strcmp(mode, "physical") == 0)
        return 0x474D0103;
    return 0;
}
