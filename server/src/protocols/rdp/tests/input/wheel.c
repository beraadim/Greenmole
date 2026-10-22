/*
 * Modified for Greenmole by its maintainers.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Exercise the production queue consumer without a server or render thread.
 * Rename only exported functions so the linked plugin stays independent. */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include <freerdp/codec/color.h>
#include <winpr/shell.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#define guac_rdp_input_event_enqueue wheel_test_enqueue
#define guac_rdp_handle_input_events wheel_test_handle_events
#define guac_display_render_thread_notify_user_moved_mouse wheel_test_notify
#include "../../input-queue.c"

#include <CUnit/CUnit.h>
#include <string.h>

static UINT16 sent_flags[16];
static int sent_count;

void wheel_test_notify(guac_display_render_thread* thread, guac_user* user,
        int x, int y, int mask) {
    (void) thread; (void) user; (void) x; (void) y; (void) mask;
}

static BOOL capture_mouse(rdpInput* input, UINT16 flags, UINT16 x, UINT16 y) {
    (void) input;
    CU_ASSERT_EQUAL(x, 420);
    CU_ASSERT_EQUAL(y, 315);
    if (sent_count < 16)
        sent_flags[sent_count] = flags;
    sent_count++;
    return TRUE;
}

typedef struct wheel_fixture {
    guac_rdp_client client;
    freerdp instance;
    rdp_freerdp_context context;
    rdpInput input;
} wheel_fixture;

static void init_fixture(wheel_fixture* f) {
    memset(f, 0, sizeof(*f));
    memset(sent_flags, 0, sizeof(sent_flags));
    sent_count = 0;
    guac_rwlock_init(&f->client.lock);
    pthread_mutex_init(&f->client.message_lock, NULL);
    f->client.rdp_inst = &f->instance;
    f->instance.context = &f->context._p;
    f->context._p.input = &f->input;
    f->context._p.settings = freerdp_settings_new(0);
    CU_ASSERT_PTR_NOT_NULL_FATAL(f->context._p.settings);
#ifdef HAVE_SETTERS_GETTERS
    freerdp_settings_set_bool(f->context._p.settings, FreeRDP_HasHorizontalWheel, TRUE);
#else
    f->context._p.settings->HasHorizontalWheel = TRUE;
#endif
    f->input.MouseEvent = capture_mouse;
}

static void free_fixture(wheel_fixture* f) {
    freerdp_settings_free(f->context._p.settings);
    pthread_mutex_destroy(&f->client.message_lock);
    guac_rwlock_destroy(&f->client.lock);
}

static void send_mask(wheel_fixture* f, int mask) {
    guac_rdp_input_event event;
    memset(&event, 0, sizeof(event));
    event.type = GUAC_RDP_INPUT_EVENT_MOUSE;
    event.details.mouse.x = 420;
    event.details.mouse.y = 315;
    event.details.mouse.mask = mask;
    guac_rdp_handle_mouse_event(&f->client, &event);
}

void test_input_wheel__vertical_and_horizontal_pulses_are_independent() {
    wheel_fixture f;
    init_fixture(&f);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_UP);
    send_mask(&f, 0);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_DOWN);
    send_mask(&f, 0);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_LEFT);
    send_mask(&f, 0);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_RIGHT);
    send_mask(&f, 0);
    CU_ASSERT_EQUAL(sent_count, 4);
    CU_ASSERT_EQUAL(sent_flags[0], PTR_FLAGS_WHEEL | 0x78);
    CU_ASSERT_EQUAL(sent_flags[1], PTR_FLAGS_WHEEL | PTR_FLAGS_WHEEL_NEGATIVE | 0x88);
    CU_ASSERT_EQUAL(sent_flags[2], PTR_FLAGS_HWHEEL | PTR_FLAGS_WHEEL_NEGATIVE | 0x88);
    CU_ASSERT_EQUAL(sent_flags[3], PTR_FLAGS_HWHEEL | 0x78);
    CU_ASSERT_EQUAL(f.client.mouse_button_mask, 0);
    free_fixture(&f);
}

void test_input_wheel__button_chords_do_not_duplicate_or_mix_wheel_flags() {
    wheel_fixture f;
    init_fixture(&f);
    send_mask(&f, GUAC_CLIENT_MOUSE_LEFT | GUAC_CLIENT_MOUSE_SCROLL_DOWN
            | GUAC_CLIENT_MOUSE_SCROLL_RIGHT);
    CU_ASSERT_EQUAL(sent_count, 3);
    CU_ASSERT_EQUAL(sent_flags[0], PTR_FLAGS_DOWN | PTR_FLAGS_BUTTON1);
    CU_ASSERT_EQUAL(sent_flags[1], PTR_FLAGS_WHEEL | PTR_FLAGS_WHEEL_NEGATIVE | 0x88);
    CU_ASSERT_EQUAL(sent_flags[2], PTR_FLAGS_HWHEEL | 0x78);
    send_mask(&f, GUAC_CLIENT_MOUSE_LEFT);
    CU_ASSERT_EQUAL(sent_count, 3);
    send_mask(&f, 0);
    CU_ASSERT_EQUAL(sent_count, 4);
    CU_ASSERT_EQUAL(sent_flags[3], PTR_FLAGS_BUTTON1);
    free_fixture(&f);
}

void test_input_wheel__unchanged_mask_moves_without_repeating_and_disconnected_drops() {
    wheel_fixture f;
    init_fixture(&f);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_LEFT);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_LEFT);
    CU_ASSERT_EQUAL(sent_count, 2);
    CU_ASSERT_EQUAL(sent_flags[1], PTR_FLAGS_MOVE);
    send_mask(&f, 0);
    f.client.rdp_inst = NULL;
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_RIGHT);
    CU_ASSERT_EQUAL(sent_count, 2);
    CU_ASSERT_EQUAL(f.client.mouse_button_mask, 0);
    free_fixture(&f);
}

void test_input_wheel__unadvertised_horizontal_input_is_dropped_without_affecting_vertical() {
    wheel_fixture f;
    init_fixture(&f);
#ifdef HAVE_SETTERS_GETTERS
    freerdp_settings_set_bool(f.context._p.settings, FreeRDP_HasHorizontalWheel, FALSE);
#else
    f.context._p.settings->HasHorizontalWheel = FALSE;
#endif
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_LEFT);
    send_mask(&f, 0);
    send_mask(&f, GUAC_CLIENT_MOUSE_SCROLL_RIGHT | GUAC_CLIENT_MOUSE_SCROLL_UP);
    send_mask(&f, 0);
    CU_ASSERT_EQUAL(sent_count, 1);
    CU_ASSERT_EQUAL(sent_flags[0], PTR_FLAGS_WHEEL | 0x78);
    CU_ASSERT_EQUAL(f.client.mouse_button_mask, 0);
    free_fixture(&f);
}
