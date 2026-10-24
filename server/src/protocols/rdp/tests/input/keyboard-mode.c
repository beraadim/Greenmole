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

#include "../../keymap.h"
#include "../../settings.h"

#include <CUnit/CUnit.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

static int layout_warnings;
static int mode_warnings;

static void capture_warning(guac_client* client, guac_client_log_level level,
        const char* format, va_list args) {
    (void) client;
    (void) args;
    if (level != GUAC_LOG_WARNING)
        return;
    if (strstr(format, "Unsupported server keyboard layout") != NULL)
        layout_warnings++;
    if (strstr(format, "Unsupported Greenmole keyboard mode") != NULL)
        mode_warnings++;
}

/* Parse the actual advertised argument list, with no credentials or connection. */
static guac_rdp_settings* parse(const char* layout, const char* mode) {
    size_t count = 0;
    while (GUAC_RDP_CLIENT_ARGS[count] != NULL)
        count++;
    const char** arguments = calloc(count, sizeof(char*));
    if (arguments == NULL)
        return NULL;
    for (size_t i = 0; i < count; i++) {
        arguments[i] = "";
        if (strcmp(GUAC_RDP_CLIENT_ARGS[i], "server-layout") == 0)
            arguments[i] = layout;
        if (strcmp(GUAC_RDP_CLIENT_ARGS[i], "greenmole-keyboard-mode") == 0)
            arguments[i] = mode;
    }
    guac_client client = {0};
    guac_user user = {0};
    client.log_handler = capture_warning;
    user.client = &client;
    user.info.optimal_width = 1280;
    user.info.optimal_height = 720;
    user.info.optimal_resolution = 96;
    layout_warnings = 0;
    mode_warnings = 0;
    guac_rdp_settings* settings = guac_rdp_parse_args(&user, (int) count, arguments);
    free(arguments);
    return settings;
}

void test_input_keyboard__norwegian_alias_is_identical_and_defaults_remain_us() {
    const guac_rdp_keymap* norwegian = guac_rdp_keymap_find("no-no-qwerty");
    CU_ASSERT_PTR_NOT_NULL_FATAL(norwegian);
    CU_ASSERT_PTR_EQUAL(guac_rdp_keymap_find("nb-no-qwerty"), norwegian);
    CU_ASSERT_EQUAL(norwegian->freerdp_keyboard_layout, 0x0414);
    CU_ASSERT_PTR_NULL(guac_rdp_keymap_find(NULL));
    CU_ASSERT_PTR_NULL(guac_rdp_keymap_find("unknown-layout"));
    guac_rdp_settings* settings = parse("", "");
    CU_ASSERT_PTR_NOT_NULL_FATAL(settings);
    CU_ASSERT_STRING_EQUAL(settings->server_layout->name, "en-us-qwerty");
    CU_ASSERT_EQUAL(settings->keyboard_subtype, 0);
    CU_ASSERT_EQUAL(layout_warnings, 0);
    CU_ASSERT_EQUAL(mode_warnings, 0);
    CU_ASSERT_STRING_EQUAL(settings->client_name, "Guacamole RDP");
    guac_rdp_settings_free(settings);
}

void test_input_keyboard__named_modes_do_not_override_layout_or_client_name() {
    const char* modes[] = {"windows", "mac", "physical"};
    for (unsigned int i = 0; i < 3; i++) {
        guac_rdp_settings* settings = parse("nb-no-qwerty", modes[i]);
        CU_ASSERT_PTR_NOT_NULL_FATAL(settings);
        CU_ASSERT_STRING_EQUAL(settings->server_layout->name, "no-no-qwerty");
        CU_ASSERT_EQUAL(settings->keyboard_subtype, 0x474D0101 + i);
        CU_ASSERT_EQUAL(layout_warnings, 0);
        CU_ASSERT_EQUAL(mode_warnings, 0);
        CU_ASSERT_STRING_EQUAL(settings->client_name, "Guacamole RDP");
        guac_rdp_settings_free(settings);
    }
}

void test_input_keyboard__unsupported_settings_fall_back_with_content_free_warnings() {
    guac_rdp_settings* settings = parse("unrecognized-layout", "unrecognized-mode");
    CU_ASSERT_PTR_NOT_NULL_FATAL(settings);
    CU_ASSERT_STRING_EQUAL(settings->server_layout->name, "en-us-qwerty");
    CU_ASSERT_EQUAL(settings->keyboard_subtype, 0);
    CU_ASSERT_EQUAL(layout_warnings, 1);
    CU_ASSERT_EQUAL(mode_warnings, 1);
    guac_rdp_settings_free(settings);
    settings = parse("de-de-qwertz", "auto");
    CU_ASSERT_PTR_NOT_NULL_FATAL(settings);
    CU_ASSERT_EQUAL(settings->keyboard_subtype, 0);
    CU_ASSERT_STRING_EQUAL(settings->server_layout->name, "de-de-qwertz");
    CU_ASSERT_EQUAL(mode_warnings, 0);
    guac_rdp_settings_free(settings);
}

void test_input_keyboard__oem_subtype_parser_accepts_only_exact_known_names() {
    const char* invalid[] = {NULL, "", "auto", "MAC", " mac", "mac\n", "0x474D0102"};
    for (unsigned int i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
        CU_ASSERT_EQUAL(guac_rdp_keyboard_mode_subtype(invalid[i]), 0);
    CU_ASSERT_EQUAL(guac_rdp_keyboard_mode_subtype("windows"), 0x474D0101);
    CU_ASSERT_EQUAL(guac_rdp_keyboard_mode_subtype("mac"), 0x474D0102);
    CU_ASSERT_EQUAL(guac_rdp_keyboard_mode_subtype("physical"), 0x474D0103);
}


/* Inspect the generated mappings, not a duplicate handwritten test table. */
static const guac_rdp_keysym_desc* find_mapping(const guac_rdp_keymap* map,
        int keysym, int scancode) {
    for (const guac_rdp_keysym_desc* key = map->mapping; key->keysym != 0; key++) {
        if (key->keysym == keysym && key->scancode == scancode)
            return key;
    }
    return NULL;
}

void test_input_keyboard__french_dead_accents_and_german_literal_altgr() {
    const guac_rdp_keymap* french = guac_rdp_keymap_find("fr-fr-azerty");
    const guac_rdp_keymap* german = guac_rdp_keymap_find("de-de-qwertz");
    CU_ASSERT_PTR_NOT_NULL_FATAL(french);
    CU_ASSERT_PTR_NOT_NULL_FATAL(german);
    const guac_rdp_keysym_desc* tilde = find_mapping(french, 0xFE53, 0x03);
    const guac_rdp_keysym_desc* grave = find_mapping(french, 0xFE50, 0x08);
    CU_ASSERT_PTR_NOT_NULL_FATAL(tilde);
    CU_ASSERT_PTR_NOT_NULL_FATAL(grave);
    CU_ASSERT(tilde->set_modifiers & GUAC_RDP_KEYMAP_MODIFIER_ALTGR);
    CU_ASSERT(grave->set_modifiers & GUAC_RDP_KEYMAP_MODIFIER_ALTGR);
    CU_ASSERT(tilde->clear_modifiers & GUAC_RDP_KEYMAP_MODIFIER_SHIFT);
    CU_ASSERT(grave->clear_modifiers & GUAC_RDP_KEYMAP_MODIFIER_SHIFT);
    CU_ASSERT_PTR_NULL(find_mapping(french, '~', 0x03));
    CU_ASSERT_PTR_NULL(find_mapping(french, '`', 0x08));
    CU_ASSERT_PTR_NULL(find_mapping(german, 0xFE53, 0x0C));
    CU_ASSERT_PTR_NOT_NULL(find_mapping(german, '\\', 0x0C));
    CU_ASSERT_PTR_NOT_NULL(find_mapping(german, '~', 0x1B));
}
