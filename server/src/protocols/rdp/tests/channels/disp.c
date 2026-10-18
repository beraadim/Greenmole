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

/* Isolate GNU extensions in FreeRDP 2's inline color helpers from the
 * pedantic checks, as in the other RDP callback tests. */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include <freerdp/codec/color.h>
#include <winpr/shell.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

/* Exercise the actual channel callbacks with a deterministic clock. Rename
 * exported functions so they do not replace the linked plugin's functions. */
#define guac_timestamp_current disp_test_timestamp_current
#define guac_rdp_disp_alloc disp_test_alloc
#define guac_rdp_disp_free disp_test_free
#define guac_rdp_disp_load_plugin disp_test_load_plugin
#define guac_rdp_disp_set_size disp_test_set_size
#define guac_rdp_disp_update_size disp_test_update_size
#define guac_rdp_disp_reconnect_needed disp_test_reconnect_needed
#define guac_rdp_disp_reconnect_complete disp_test_reconnect_complete
#include "../../channels/disp.c"

#include <CUnit/CUnit.h>
#include <freerdp/settings.h>

static guac_timestamp clock_now;

guac_timestamp disp_test_timestamp_current(void) {
    return clock_now;
}

typedef struct disp_fixture {
    guac_client client;
    guac_rdp_client rdp_client;
    guac_rdp_settings settings;
    rdp_freerdp_context context;
    freerdp instance;
    DispClientContext channel;
    guac_rdp_disp* disp;
    int sends;
    int invalid_layouts;
    UINT status;
    DISPLAY_CONTROL_MONITOR_LAYOUT sent;
} disp_fixture;

static UINT capture_layout(DispClientContext* context, UINT32 count,
        DISPLAY_CONTROL_MONITOR_LAYOUT* monitors) {
    /* The production callback owns custom; the fake plugin owns handle. */
    disp_fixture* f = context->handle;
    if (count != 1) {
        f->invalid_layouts++;
        return 1;
    }
    if (monitors[0].Width * 9 != monitors[0].Height * 16)
        f->invalid_layouts++;
    if (!f->disp->caps_ready || f->disp->disp != context)
        f->invalid_layouts++;
    f->sends++;
    f->sent = monitors[0];
    return f->status;
}

static void init_fixture(disp_fixture* f) {
    memset(f, 0, sizeof(*f));
    clock_now = 1000;
    f->client.data = &f->rdp_client;
    f->rdp_client.settings = &f->settings;
    f->settings.resize_method = GUAC_RESIZE_DISPLAY_UPDATE;
    pthread_mutexattr_t attributes;
    pthread_mutexattr_init(&attributes);
    pthread_mutexattr_settype(&attributes, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&f->rdp_client.message_lock, &attributes);
    pthread_mutexattr_destroy(&attributes);
    f->context.client = &f->client;
    f->context._p.instance = &f->instance;
    f->context._p.settings = freerdp_settings_new(0);
    CU_ASSERT_PTR_NOT_NULL_FATAL(f->context._p.settings);
    f->instance.context = &f->context._p;
#ifdef HAVE_SETTERS_GETTERS
    freerdp_settings_set_uint32(f->context._p.settings, FreeRDP_DesktopWidth, 1280);
    freerdp_settings_set_uint32(f->context._p.settings, FreeRDP_DesktopHeight, 720);
#else
    f->instance.settings = f->context._p.settings;
    f->instance.settings->DesktopWidth = 1280;
    f->instance.settings->DesktopHeight = 720;
#endif
    f->channel.handle = f;
    f->channel.SendMonitorLayout = capture_layout;
    f->disp = f->rdp_client.disp = disp_test_alloc(&f->client);
    CU_ASSERT_PTR_NOT_NULL_FATAL(f->disp);
}

static void free_fixture(disp_fixture* f) {
    disp_test_free(f->disp);
    freerdp_settings_free(f->context._p.settings);
    pthread_mutex_destroy(&f->rdp_client.message_lock);
}

static void channel_connected(disp_fixture* f, const char* name) {
    ChannelConnectedEventArgs args = {0};
    args.name = name;
    args.pInterface = &f->channel;
    guac_rdp_disp_channel_connected(&f->context._p, &args);
}

static void capabilities_ready(disp_fixture* f) {
    CU_ASSERT_PTR_NOT_NULL_FATAL(f->channel.DisplayControlCaps);
    /* FreeRDP may dispatch this callback while processing a server message
     * under the same recursive message lock used by SendMonitorLayout. */
    pthread_mutex_lock(&f->rdp_client.message_lock);
    CU_ASSERT_EQUAL(f->channel.DisplayControlCaps(&f->channel, 1, 8192, 8192),
            CHANNEL_RC_OK);
    pthread_mutex_unlock(&f->rdp_client.message_lock);
}

void test_disp__capabilities_preserve_and_send_deferred_viewport() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    CU_ASSERT_EQUAL(f.sends, 0);
    CU_ASSERT_EQUAL(f.disp->last_request, 1000);

    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    CU_ASSERT_PTR_EQUAL(f.disp->disp, &f.channel);
    CU_ASSERT_EQUAL(f.disp->requested_width, 1600);
    CU_ASSERT_EQUAL(f.disp->requested_height, 900);
    CU_ASSERT_EQUAL(f.sends, 0);
    CU_ASSERT_FALSE(f.disp->caps_ready);
    capabilities_ready(&f);
    CU_ASSERT_TRUE(f.disp->caps_ready);
    CU_ASSERT_EQUAL(f.sends, 1);
    CU_ASSERT_EQUAL(f.sent.Width, 1600);
    CU_ASSERT_EQUAL(f.sent.Height, 900);
    CU_ASSERT_EQUAL(f.disp->last_request, 1600);
    free_fixture(&f);
}

void test_disp__channel_open_seeds_negotiated_size_only_without_a_request() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    channel_connected(&f, "unrelated-channel");
    CU_ASSERT_PTR_NULL(f.disp->disp);
    CU_ASSERT_EQUAL(f.disp->requested_width, 0);
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    CU_ASSERT_EQUAL(f.disp->requested_width, 1280);
    CU_ASSERT_EQUAL(f.disp->requested_height, 720);
    capabilities_ready(&f);
    CU_ASSERT_EQUAL(f.sends, 0);
    free_fixture(&f);
}

void test_disp__only_latest_viewport_survives_channel_startup() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    clock_now = 1650;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1920, 1080);
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    clock_now = 1700;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 2560, 1440);
    disp_test_update_size(f.disp, &f.settings, &f.instance);
    CU_ASSERT_EQUAL(f.sends, 0);
    CU_ASSERT_EQUAL(f.disp->last_request, 1000);
    capabilities_ready(&f);
    CU_ASSERT_EQUAL(f.sends, 1);
    CU_ASSERT_EQUAL(f.sent.Width, 2560);
    CU_ASSERT_EQUAL(f.sent.Height, 1440);
    free_fixture(&f);
}

void test_disp__newer_viewport_keeps_existing_send_throttle() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    capabilities_ready(&f);
    clock_now = 1700;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1920, 1080);
    CU_ASSERT_EQUAL(f.sends, 1);
    clock_now = 2101;
    disp_test_update_size(f.disp, &f.settings, &f.instance);
    CU_ASSERT_EQUAL(f.sends, 2);
    CU_ASSERT_EQUAL(f.sent.Width, 1920);
    CU_ASSERT_EQUAL(f.sent.Height, 1080);
    free_fixture(&f);
}

void test_disp__negotiated_size_does_not_send_or_delay_a_new_viewport() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    capabilities_ready(&f);
    /* The channel's borrowed instance is already available even when the
     * user-facing client instance has not yet been published. */
    disp_test_set_size(f.disp, &f.settings, NULL, 1280, 720);
    CU_ASSERT_EQUAL(f.sends, 0);
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    CU_ASSERT_EQUAL(f.sends, 1);
    CU_ASSERT_EQUAL(f.sent.Width, 1600);
    free_fixture(&f);
}

typedef struct concurrent_disp_fixture {
    disp_fixture* f;
    pthread_mutex_t start_lock;
    pthread_cond_t start_condition;
    int threads_ready;
    int start;
} concurrent_disp_fixture;

static void wait_for_concurrent_start(concurrent_disp_fixture* concurrent) {
    pthread_mutex_lock(&concurrent->start_lock);
    concurrent->threads_ready++;
    pthread_cond_broadcast(&concurrent->start_condition);
    while (!concurrent->start)
        pthread_cond_wait(&concurrent->start_condition, &concurrent->start_lock);
    pthread_mutex_unlock(&concurrent->start_lock);
}

static void advance_concurrent_clock(disp_fixture* f) {
    pthread_mutex_lock(&f->rdp_client.message_lock);
    clock_now += GUAC_RDP_DISP_UPDATE_INTERVAL + 1;
    pthread_mutex_unlock(&f->rdp_client.message_lock);
}

static void* request_concurrent_viewports(void* data) {
    concurrent_disp_fixture* concurrent = data;
    disp_fixture* f = concurrent->f;
    wait_for_concurrent_start(concurrent);
    for (int i = 0; i < 1000; i++) {
        advance_concurrent_clock(f);
        disp_test_set_size(f->disp, &f->settings, NULL, 1600, 900);
        advance_concurrent_clock(f);
        disp_test_set_size(f->disp, &f->settings, NULL, 1920, 1080);
    }
    return NULL;
}

static void* reopen_concurrent_channel(void* data) {
    concurrent_disp_fixture* concurrent = data;
    disp_fixture* f = concurrent->f;
    wait_for_concurrent_start(concurrent);
    for (int i = 0; i < 1000; i++) {
        channel_connected(f, DISP_DVC_CHANNEL_NAME);
        pthread_mutex_lock(&f->rdp_client.message_lock);
        clock_now += GUAC_RDP_DISP_UPDATE_INTERVAL + 1;
        f->channel.DisplayControlCaps(&f->channel, 1, 8192, 8192);
        pthread_mutex_unlock(&f->rdp_client.message_lock);
        disp_test_update_size(f->disp, &f->settings, NULL);
        disp_test_reconnect_needed(f->disp);
        disp_test_reconnect_complete(f->disp);
        ChannelDisconnectedEventArgs args = {0};
        args.name = DISP_DVC_CHANNEL_NAME;
        guac_rdp_disp_channel_disconnected(&f->context._p, &args);
    }
    return NULL;
}

void test_disp__concurrent_viewports_and_channel_reopen_keep_atomic_state() {
    disp_fixture f;
    init_fixture(&f);
    concurrent_disp_fixture concurrent = { .f = &f };
    pthread_mutex_init(&concurrent.start_lock, NULL);
    pthread_cond_init(&concurrent.start_condition, NULL);
    pthread_t browser;
    pthread_t channel;
    int browser_created = pthread_create(&browser, NULL,
            request_concurrent_viewports, &concurrent);
    int channel_created = pthread_create(&channel, NULL,
            reopen_concurrent_channel, &concurrent);
    CU_ASSERT_EQUAL(browser_created, 0);
    CU_ASSERT_EQUAL(channel_created, 0);
    pthread_mutex_lock(&concurrent.start_lock);
    while (concurrent.threads_ready < (browser_created == 0) + (channel_created == 0))
        pthread_cond_wait(&concurrent.start_condition, &concurrent.start_lock);
    concurrent.start = 1;
    pthread_cond_broadcast(&concurrent.start_condition);
    pthread_mutex_unlock(&concurrent.start_lock);
    if (browser_created == 0)
        pthread_join(browser, NULL);
    if (channel_created == 0)
        pthread_join(channel, NULL);

    /* The final request is deterministic regardless of thread scheduling. No
     * observed layout may mix dimensions from two independent requests. */
    CU_ASSERT_EQUAL(f.invalid_layouts, 0);
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    advance_concurrent_clock(&f);
    disp_test_set_size(f.disp, &f.settings, NULL, 2560, 1440);
    capabilities_ready(&f);
    CU_ASSERT_EQUAL(f.disp->requested_width, 2560);
    CU_ASSERT_EQUAL(f.disp->requested_height, 1440);
    CU_ASSERT_EQUAL(f.sent.Width, 2560);
    CU_ASSERT_EQUAL(f.sent.Height, 1440);
    pthread_cond_destroy(&concurrent.start_condition);
    pthread_mutex_destroy(&concurrent.start_lock);
    free_fixture(&f);
}

void test_disp__failed_layout_send_retains_viewport_for_bounded_retry() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    f.status = 1;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    capabilities_ready(&f);
    CU_ASSERT_EQUAL(f.sends, 1);
    CU_ASSERT_EQUAL(f.disp->requested_width, 1600);
    CU_ASSERT_EQUAL(f.disp->requested_height, 900);
    clock_now = 1700;
    disp_test_update_size(f.disp, &f.settings, &f.instance);
    CU_ASSERT_EQUAL(f.sends, 1);
    clock_now = 2101;
    f.status = 0;
    disp_test_update_size(f.disp, &f.settings, &f.instance);
    CU_ASSERT_EQUAL(f.sends, 2);
    CU_ASSERT_EQUAL(f.sent.Width, 1600);
    CU_ASSERT_EQUAL(f.sent.Height, 900);
    free_fixture(&f);
}

void test_disp__disconnect_requires_new_capabilities_and_keeps_pending_viewport() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    capabilities_ready(&f);

    ChannelDisconnectedEventArgs args = {0};
    args.name = DISP_DVC_CHANNEL_NAME;
    guac_rdp_disp_channel_disconnected(&f.context._p, &args);
    CU_ASSERT_PTR_NULL(f.disp->disp);
    CU_ASSERT_PTR_NULL(f.disp->rdp_inst);
    CU_ASSERT_FALSE(f.disp->caps_ready);
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    channel_connected(&f, DISP_DVC_CHANNEL_NAME);
    CU_ASSERT_EQUAL(f.sends, 0);
    capabilities_ready(&f);
    CU_ASSERT_EQUAL(f.sends, 1);
    CU_ASSERT_EQUAL(f.sent.Width, 1600);
    CU_ASSERT_EQUAL(f.sent.Height, 900);
    free_fixture(&f);
}

void test_disp__null_channel_interface_keeps_pending_viewport_without_sending() {
    disp_fixture f;
    init_fixture(&f);
    clock_now = 1600;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    ChannelConnectedEventArgs args = {0};
    args.name = DISP_DVC_CHANNEL_NAME;
    guac_rdp_disp_channel_connected(&f.context._p, &args);
    CU_ASSERT_PTR_NULL(f.disp->disp);
    CU_ASSERT_PTR_NULL(f.disp->rdp_inst);
    CU_ASSERT_FALSE(f.disp->caps_ready);
    CU_ASSERT_EQUAL(f.disp->requested_width, 1600);
    CU_ASSERT_EQUAL(f.disp->requested_height, 900);
    CU_ASSERT_EQUAL(f.sends, 0);
    free_fixture(&f);
}

void test_disp__reconnect_method_still_updates_settings_and_signals_reconnect() {
    disp_fixture f;
    init_fixture(&f);
    f.settings.resize_method = GUAC_RESIZE_RECONNECT;
    clock_now = 1600;
    disp_test_set_size(f.disp, &f.settings, &f.instance, 1600, 900);
    CU_ASSERT_TRUE(f.disp->reconnect_needed);
    CU_ASSERT_EQUAL(f.settings.width, 1600);
    CU_ASSERT_EQUAL(f.settings.height, 900);
    CU_ASSERT_EQUAL(f.disp->last_request, 1600);
    CU_ASSERT_EQUAL(f.sends, 0);
    free_fixture(&f);
}
