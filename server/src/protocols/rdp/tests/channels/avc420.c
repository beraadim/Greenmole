/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include <freerdp/codec/color.h>
#include <winpr/shell.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include "channels/avc420-priv.h"
#include "rdp.h"
#include "../../../../libguac/display-priv.h"
#include <CUnit/CUnit.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/gdi/gdi.h>
#include <guacamole/socket.h>
#include <guacamole/timestamp.h>
#include <stdlib.h>
#include <string.h>

static const unsigned char key[] = {0,0,0,1,0x67,0x42,0,0x1f,
    0,0,1,0x68,0x80,0,0,1,0x65,0x88};
static const char* mimes[] = { GUAC_RDP_AVC420_MIMETYPE, NULL };

typedef struct fixture {
    guac_client* client;
    guac_user* owner;
    guac_rdp_client rdp;
    guac_rdp_settings settings;
    char output[65536];
    size_t length;
} fixture;

static int contains(fixture* f, const char* text) {
    size_t length = strlen(text);
    for (size_t i = 0; i + length <= f->length; i++)
        if (!memcmp(f->output + i, text, length)) return 1;
    return 0;
}

static ssize_t write_video(guac_socket* socket, const void* data, size_t length) {
    fixture* f = socket->data;
    if (length > sizeof(f->output) - f->length) return -1;
    memcpy(f->output + f->length, data, length);
    f->length += length;
    return length;
}

static void init_fixture(fixture* f, int capable) {
    memset(f, 0, sizeof(*f));
    f->client = guac_client_alloc();
    CU_ASSERT_PTR_NOT_NULL_FATAL(f->client);
    f->owner = guac_user_alloc();
    CU_ASSERT_PTR_NOT_NULL_FATAL(f->owner);
    f->owner->client = f->client;
    f->owner->owner = 1;
    f->owner->data = &f->settings;
    f->owner->info.video_mimetypes = capable ? mimes : NULL;
    f->owner->socket = guac_socket_alloc();
    f->owner->socket->data = f;
    f->owner->socket->write_handler = write_video;
    f->client->data = &f->rdp;
    f->client->__owner = f->client->__users = f->owner;
    f->client->connected_users = 1;
    f->settings.enable_gfx = 1;
    f->rdp.avc420 = guac_rdp_avc420_alloc();
    f->rdp.display = guac_display_alloc(f->client);
    guac_rdp_avc420_join(f->client, f->owner);
}

static void free_fixture(fixture* f) {
    guac_display_free(f->rdp.display);
    guac_rdp_avc420_free(f->rdp.avc420);
    f->client->__owner = f->client->__users = NULL;
    f->client->connected_users = 0;
    guac_socket_free(f->owner->socket);
    guac_user_free(f->owner);
    guac_client_free(f->client);
}

static void ready(fixture* f) {
    guac_rdp_avc420_open(f->client);
    guac_stream* stream = f->rdp.avc420->stream;
    CU_ASSERT_PTR_NOT_NULL_FATAL(stream);
    stream->ack_handler(f->owner, stream, "AVC420:ready", GUAC_PROTOCOL_STATUS_SUCCESS);
}
static void frame(fixture* f) {
    guac_rdp_avc420* v = f->rdp.avc420;
    v->frame = malloc(sizeof(key));
    CU_ASSERT_PTR_NOT_NULL_FATAL(v->frame);
    memcpy(v->frame, key, sizeof(key));
    v->frame_length = sizeof(key);
    v->width = v->height = 16;
    v->frame_key = 1;
    v->supported_frame = v->commands = 1;
    guac_rdp_avc420_send_frame(f->client);
}

void test_avc420__capability_recording_and_shared_viewer_gate() {
    fixture f;
    init_fixture(&f, 0);
    CU_ASSERT_FALSE(guac_rdp_avc420_enabled(f.client));
    guac_rdp_avc420_open(f.client);
    CU_ASSERT_PTR_NULL(f.rdp.avc420->stream);
    free_fixture(&f);
    init_fixture(&f, 1);
    f.settings.recording_path = "/test-recording";
    f.rdp.avc420->enabled = 0;
    guac_rdp_avc420_join(f.client, f.owner);
    CU_ASSERT_FALSE(guac_rdp_avc420_enabled(f.client));
    free_fixture(&f);
    init_fixture(&f, 1);
    CU_ASSERT_TRUE(guac_rdp_avc420_enabled(f.client));
    guac_user shared = { .client = f.client };
    guac_rdp_avc420_join(f.client, &shared);
    CU_ASSERT_FALSE(guac_rdp_avc420_enabled(f.client));
    CU_ASSERT_TRUE(f.rdp.avc420->refresh);
    free_fixture(&f);
}

void test_avc420__annex_b_seed_and_network_header() {
    CU_ASSERT_TRUE(guac_rdp_avc420_key_frame(key, sizeof(key)));
    CU_ASSERT_FALSE(guac_rdp_avc420_key_frame(key + 8, sizeof(key) - 8));
    const unsigned char delta[] = {0,0,1,0x41,0x88};
    CU_ASSERT_FALSE(guac_rdp_avc420_key_frame(delta, sizeof(delta)));
    CU_ASSERT_FALSE(guac_rdp_avc420_key_frame(key, 3));
    unsigned char header[20];
    guac_rdp_avc420_header(header, 0x1020304, 318, 178, 1, 0x5060708);
    const unsigned char expected[] = {'G','A','V','1',1,2,3,4,1,62,0,178,
        0,0,0,1,5,6,7,8};
    CU_ASSERT_EQUAL(memcmp(header, expected, sizeof(header)), 0);
}

void test_avc420__presentation_ack_gates_image_suppression_and_closes_display_frame() {
    fixture f;
    init_fixture(&f, 1);
    ready(&f);
    frame(&f);
    CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
    CU_ASSERT_EQUAL(f.rdp.avc420->pending_count, 1);
    CU_ASSERT_TRUE(contains(&f, "4.sync,"));
    guac_stream* stream = f.rdp.avc420->stream;
    stream->ack_handler(f.owner, stream, "AVC420:1", GUAC_PROTOCOL_STATUS_SUCCESS);
    CU_ASSERT_TRUE(guac_rdp_avc420_suppress_paint(f.client));
    CU_ASSERT_EQUAL(f.rdp.avc420->pending_bytes, 0);
    stream->ack_handler(f.owner, stream, "AVC420:1", GUAC_PROTOCOL_STATUS_SUCCESS);
    CU_ASSERT_TRUE(f.rdp.avc420->disabled);
    CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
    guac_rdp_avc420_poll(f.client);
    CU_ASSERT_PTR_NULL(f.rdp.avc420->stream);
    CU_ASSERT_TRUE(contains(&f, "3.end,"));
    free_fixture(&f);
}

void test_avc420__out_of_order_and_decoder_error_ack_force_image_fallback() {
    for (int error = 0; error < 2; error++) {
        fixture f;
        init_fixture(&f, 1);
        ready(&f);
        frame(&f);
        guac_stream* stream = f.rdp.avc420->stream;
        stream->ack_handler(f.owner, stream, error ? "AVC420:fallback" : "AVC420:2",
                error ? GUAC_PROTOCOL_STATUS_CLIENT_BAD_TYPE : GUAC_PROTOCOL_STATUS_SUCCESS);
        CU_ASSERT_TRUE(f.rdp.avc420->disabled);
        CU_ASSERT_TRUE(f.rdp.avc420->refresh);
        guac_rdp_avc420_poll(f.client);
        CU_ASSERT_PTR_NULL(f.rdp.avc420->stream);
        free_fixture(&f);
    }
}

void test_avc420__network_backlog_and_idle_deadline_are_bounded() {
    fixture f;
    init_fixture(&f, 1);
    ready(&f);
    f.rdp.avc420->presented = 1;
    for (unsigned int i = 0; i < GUAC_RDP_AVC420_MAX_PENDING; i++) frame(&f);
    CU_ASSERT_FALSE(f.rdp.avc420->disabled);
    frame(&f);
    CU_ASSERT_TRUE(f.rdp.avc420->disabled);
    CU_ASSERT_EQUAL(f.rdp.avc420->pending_count, GUAC_RDP_AVC420_MAX_PENDING);
    free_fixture(&f);
    init_fixture(&f, 1);
    ready(&f);
    frame(&f);
    f.rdp.avc420->pending[0].sent = guac_timestamp_current() - GUAC_RDP_AVC420_ACK_TIMEOUT;
    guac_rdp_avc420_poll(f.client);
    CU_ASSERT_TRUE(f.rdp.avc420->disabled);
    CU_ASSERT_PTR_NULL(f.rdp.avc420->stream);
    free_fixture(&f);
}

static void* delayed_ready(void* data) {
    fixture* f = data;
    guac_timestamp_msleep(30);
    guac_stream* stream = f->rdp.avc420->stream;
    stream->ack_handler(f->owner, stream, "AVC420:ready", GUAC_PROTOCOL_STATUS_SUCCESS);
    return NULL;
}

void test_avc420__first_idr_waits_for_independent_browser_ready() {
    fixture f;
    init_fixture(&f, 1);
    guac_rdp_avc420_open(f.client);
    pthread_t thread;
    CU_ASSERT_EQUAL_FATAL(pthread_create(&thread, NULL, delayed_ready, &f), 0);
    CU_ASSERT_TRUE(guac_rdp_avc420_wait_ready(f.client));
    pthread_join(thread, NULL);
    CU_ASSERT_FALSE(f.rdp.avc420->disabled);
    frame(&f);
    CU_ASSERT_TRUE(f.rdp.avc420->started);
    free_fixture(&f);
}

void test_avc420__startup_image_seed_allowed_active_resize_and_owner_leave_fallback() {
    fixture f;
    init_fixture(&f, 1);
    guac_rdp_avc420_invalidate(f.client, "initial image seed");
    CU_ASSERT_TRUE(guac_rdp_avc420_enabled(f.client));
    ready(&f);
    frame(&f);
    guac_rdp_avc420_invalidate(f.client, "desktop resize");
    CU_ASSERT_FALSE(guac_rdp_avc420_enabled(f.client));
    free_fixture(&f);
    init_fixture(&f, 1);
    ready(&f);
    guac_rdp_avc420_leave(f.client, f.owner);
    CU_ASSERT_FALSE(guac_rdp_avc420_enabled(f.client));
    CU_ASSERT_PTR_NULL(f.rdp.avc420->owner);
    CU_ASSERT_PTR_NULL(f.rdp.avc420->stream);
    free_fixture(&f);
}

static gdiGfxSurface hook_surface;
static int hook_starts, hook_surfaces, hook_ends;
static void* hook_get_surface(RdpgfxClientContext* gfx, UINT16 id) {
    return id == 1 ? &hook_surface : NULL;
}
static UINT hook_start(RdpgfxClientContext* gfx, const RDPGFX_START_FRAME_PDU* command) {
    hook_starts++;
    ((rdpGdi*) gfx->custom)->inGfxFrame = TRUE;
    return 0;
}
static UINT hook_command(RdpgfxClientContext* gfx, const RDPGFX_SURFACE_COMMAND* command) {
    hook_surfaces++;
    return 0;
}
static UINT hook_end(RdpgfxClientContext* gfx, const RDPGFX_END_FRAME_PDU* command) {
    hook_ends++;
    ((rdpGdi*) gfx->custom)->inGfxFrame = FALSE;
    return 0;
}

/** Real installed callbacks preserve GDI and accept only full mapped frames. */
void test_avc420__production_graphics_hooks_preserve_decode_and_reject_partial_frames() {
    for (int partial = 0; partial < 2; partial++) {
        fixture f;
        init_fixture(&f, 1);
        ready(&f);
        rdp_freerdp_context context = { .client = f.client };
        rdpGdi gdi = { .width = 14, .height = 10, .context = &context._p };
        RdpgfxClientContext gfx = { .custom = &gdi, .StartFrame = hook_start,
            .SurfaceCommand = hook_command, .EndFrame = hook_end,
            .GetSurfaceData = hook_get_surface };
        hook_surface = (gdiGfxSurface) { .surfaceId = 1, .width = 16, .height = 16,
            .mappedWidth = 14, .mappedHeight = 10, .outputMapped = TRUE,
            .outputTargetWidth = 14, .outputTargetHeight = 10 };
        RECTANGLE_16 rect = { .right = 14, .bottom = 10 };
        RDPGFX_AVC420_BITMAP_STREAM bs = { .length = sizeof(key), .data = (BYTE*) key,
            .meta = { .numRegionRects = 1, .regionRects = &rect } };
        RDPGFX_SURFACE_COMMAND command = { .surfaceId = 1, .codecId = RDPGFX_CODECID_AVC420,
            .right = 14, .bottom = 10, .extra = &bs };
        RDPGFX_START_FRAME_PDU start = { .frameId = 1 };
        RDPGFX_END_FRAME_PDU end = { .frameId = 1 };
        hook_starts = hook_surfaces = hook_ends = 0;
        guac_rdp_avc420_init_graphics(f.client, &gfx);
        CU_ASSERT_NOT_EQUAL(gfx.SurfaceCommand, hook_command);
        CU_ASSERT_EQUAL(gfx.StartFrame(&gfx, &start), 0);
        CU_ASSERT_EQUAL(gfx.SurfaceCommand(&gfx, &command), 0);
        CU_ASSERT_EQUAL(gfx.EndFrame(&gfx, &end), 0);
        CU_ASSERT_EQUAL(hook_starts, 1);
        CU_ASSERT_EQUAL(hook_surfaces, 1);
        CU_ASSERT_EQUAL(hook_ends, 1);
        CU_ASSERT_TRUE(f.rdp.avc420->started);
        guac_stream* stream = f.rdp.avc420->stream;
        stream->ack_handler(f.owner, stream, "AVC420:1", GUAC_PROTOCOL_STATUS_SUCCESS);
        CU_ASSERT_EQUAL(gfx.StartFrame(&gfx, &start), 0);
        if (partial) rect.right = 8;
        else command.codecId = RDPGFX_CODECID_UNCOMPRESSED;
        CU_ASSERT_EQUAL(gfx.SurfaceCommand(&gfx, &command), 0);
        CU_ASSERT_EQUAL(gfx.EndFrame(&gfx, &end), 0);
        CU_ASSERT_EQUAL(hook_surfaces, 2);
        CU_ASSERT_TRUE(f.rdp.avc420->disabled);
        CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
        free_fixture(&f);
    }
}

/** A ready/presented race must not leave an image worker behind video. */
void test_avc420__ack_midframe_retains_image_ordering_barrier() {
    fixture f;
    init_fixture(&f, 1);
    ready(&f);
    frame(&f);
    CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
    CU_ASSERT_TRUE(f.rdp.avc420->image_pending);
    guac_stream* stream = f.rdp.avc420->stream;
    stream->ack_handler(f.owner, stream, "AVC420:1", GUAC_PROTOCOL_STATUS_SUCCESS);
    CU_ASSERT_TRUE(f.rdp.avc420->presented);
    frame(&f);
    CU_ASSERT_FALSE(f.rdp.avc420->image_pending);
    CU_ASSERT_EQUAL(f.rdp.avc420->pending_count, 1);
    free_fixture(&f);
}

/** Video may differ even when the shadow returns to the old IMAGE baseline. */
void test_avc420__fallback_sends_unconditional_snapshot_for_unchanged_image_baseline() {
    fixture f;
    init_fixture(&f, 1);
    unsigned char pixels[8] = {0x11,0x22,0x33,0xff,0x44,0x55,0x66,0xff};
    rdp_freerdp_context context = { .client = f.client };
    freerdp instance = { .context = &context._p };
    rdpGdi gdi = { .width = 2, .height = 1, .stride = 8, .primary_buffer = pixels };
    context._p.gdi = &gdi;
    f.rdp.rdp_inst = &instance;
    guac_display_layer* layer = guac_display_default_layer(f.rdp.display);
    guac_display_layer_raw_context* raw = guac_display_layer_open_raw(layer);
    raw->buffer = pixels;
    raw->stride = 8;
    guac_rect_init(&raw->bounds, 0, 0, 2, 1);
    raw->dirty = raw->bounds;
    guac_display_layer_close_raw(layer, raw);
    CU_ASSERT_TRUE(guac_display_flush_to_idle(f.rdp.display, 250));
    ready(&f);
    frame(&f);
    guac_stream* stream = f.rdp.avc420->stream;
    stream->ack_handler(f.owner, stream, "AVC420:1", GUAC_PROTOCOL_STATUS_SUCCESS);
    /* Browser now shows video B; the untouched shadow/last-image both contain
     * A. A decoder failure still needs a complete A snapshot on the wire. */
    f.length = 0;
    guac_rdp_avc420_stop(f.client, "test decoder failure");
    guac_rdp_avc420_poll(f.client);
    CU_ASSERT_PTR_NULL(f.rdp.avc420->stream);
    CU_ASSERT_TRUE(contains(&f, "9.image/png"));
    CU_ASSERT_TRUE(contains(&f, "4.copy,"));
    CU_ASSERT_TRUE(contains(&f, "3.end,"));
    CU_ASSERT_FALSE(f.rdp.avc420->refresh);
    CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
    free_fixture(&f);
}

void test_avc420__classic_paint_after_gfx_end_cannot_suppress_images() {
    fixture f;
    init_fixture(&f, 1);
    ready(&f);
    frame(&f);
    f.rdp.avc420->presented = 1;
    f.rdp.avc420->supported_frame = 0;
    f.rdp.avc420->commands = 0;
    CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
    CU_ASSERT_TRUE(f.rdp.avc420->disabled);
    CU_ASSERT_TRUE(f.rdp.avc420->refresh);
    free_fixture(&f);
}

void test_avc420__mixed_first_frame_discards_cached_video_without_losing_image_seed() {
    fixture f;
    init_fixture(&f, 1);
    ready(&f);
    guac_rdp_avc420* video = f.rdp.avc420;
    video->frame = malloc(sizeof(key));
    CU_ASSERT_PTR_NOT_NULL_FATAL(video->frame);
    memcpy(video->frame, key, sizeof(key));
    video->frame_length = sizeof(key);
    video->supported_frame = 0;
    video->commands = 2;
    guac_rdp_avc420_send_frame(f.client);
    CU_ASSERT_FALSE(video->started);
    CU_ASSERT_EQUAL(video->pending_count, 0);
    CU_ASSERT_EQUAL(video->frame_length, 0);
    CU_ASSERT_PTR_NULL(video->frame);
    CU_ASSERT_TRUE(guac_rdp_avc420_enabled(f.client));
    frame(&f);
    CU_ASSERT_TRUE(video->started);
    free_fixture(&f);
}
