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
#include <guacamole/parser.h>
#include <guacamole/protocol.h>
#include <guacamole/socket.h>
#include <guacamole/timestamp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const unsigned char key[] = {0,0,0,1,0x67,0x42,0,0x1f,
    0,0,1,0x68,0x80,0,0,1,0x65,0x88};
static const char* mimes[] = { GUAC_RDP_AVC420_MIMETYPE, NULL };
static const char* mimes444[] = { GUAC_RDP_AVC420_MIMETYPE,
    GUAC_RDP_AVC444_MIMETYPE, NULL };
static const unsigned char delta[] = {0,0,1,0x41,0x88};

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
    f->owner->info.video_mimetypes = capable == 2 ? mimes444 : (capable ? mimes : NULL);
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
    stream->ack_handler(f->owner, stream,
            f->rdp.avc420->stream_avc444 ? "AVC444:ready" : "AVC420:ready",
            GUAC_PROTOCOL_STATUS_SUCCESS);
}
static void access_unit(fixture* f, int is_key) {
    guac_rdp_avc420* v = f->rdp.avc420;
    const unsigned char* main = is_key ? key : delta;
    size_t main_length = is_key ? sizeof(key) : sizeof(delta);
    size_t prefix = v->stream_avc444 ? 16 : 0;
    v->frame_length = prefix + main_length
        + (v->stream_avc444 ? sizeof(delta) : 0);
    v->frame = malloc(v->frame_length);
    CU_ASSERT_PTR_NOT_NULL_FATAL(v->frame);
    if (prefix) {
        const unsigned char rectangles[] = {0,0,0,0,0,16,0,16,0,0,0,0,0,16,0,16};
        memcpy(v->frame, rectangles, sizeof(rectangles));
        memcpy(v->frame + prefix + main_length, delta, sizeof(delta));
    }
    memcpy(v->frame + prefix, main, main_length);
    v->width = v->height = 16;
    v->frame_key = is_key;
    v->frame_aux_key = 0;
    v->frame_avc444 = v->stream_avc444;
    v->frame_main_length = main_length;
    v->frame_aux_length = v->stream_avc444 ? sizeof(delta) : 0;
    v->supported_frame = v->commands = 1;
    guac_rdp_avc420_send_frame(f->client);
}
static void frame(fixture* f) {
    access_unit(f, 1);
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

/** Protocol-size blobs retain both envelopes, all bytes and ordered frame ACKs. */
void test_avc420__protocol_blob_boundaries_preserve_access_unit_and_presentation() {
    const size_t lengths[] = { GUAC_PROTOCOL_BLOB_MAX_LENGTH - 1,
        GUAC_PROTOCOL_BLOB_MAX_LENGTH, GUAC_PROTOCOL_BLOB_MAX_LENGTH + 1,
        2 * GUAC_PROTOCOL_BLOB_MAX_LENGTH,
        2 * GUAC_PROTOCOL_BLOB_MAX_LENGTH + 1 };
    for (int avc444 = 0; avc444 <= 1; avc444++) {
        for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); i++) {
            fixture f;
            init_fixture(&f, avc444 ? 2 : 1);
            CU_ASSERT_TRUE_FATAL(guac_display_flush_to_idle(f.rdp.display, 250));
            ready(&f);
            f.length = 0;
            guac_rdp_avc420* video = f.rdp.avc420;
            size_t length = lengths[i];
            unsigned char expected[2 * GUAC_PROTOCOL_BLOB_MAX_LENGTH + 1];
            for (size_t j = 0; j < length; j++)
                expected[j] = (unsigned char) (j * 31 + j / 256);
            if (avc444) {
                const unsigned char rectangles[] = {
                    0,0,0,0,1,62,0,178, 0,0,0,0,1,62,0,178
                };
                memcpy(expected, rectangles, sizeof(rectangles));
            }
            video->frame = malloc(length);
            CU_ASSERT_PTR_NOT_NULL_FATAL(video->frame);
            memcpy(video->frame, expected, length);
            video->frame_length = length;
            video->width = 318;
            video->height = 178;
            video->frame_key = 1;
            video->frame_aux_key = 0;
            video->frame_avc444 = avc444;
            video->frame_main_length = (length - 16) / 2;
            video->frame_aux_length = length - 16 - video->frame_main_length;
            video->supported_frame = video->commands = 1;
            unsigned char expected_header[32];
            size_t header_length = avc444 ? 32 : 20;
            if (avc444)
                guac_rdp_avc444_header(expected_header, 1, 318, 178, 1, 0,
                        video->frame_main_length, video->frame_aux_length);
            else
                guac_rdp_avc420_header(expected_header, 1, 318, 178, 1, length);

            guac_rdp_avc420_send_frame(f.client);
            CU_ASSERT_TRUE(video->started);
            CU_ASSERT_EQUAL(video->pending_count, 1);
            CU_ASSERT_EQUAL(video->pending_bytes, length);
            size_t offset = 0, reassembled = 0;
            unsigned int blobs = 0, syncs = 0;
            while (offset < f.length) {
                guac_parser* parser = guac_parser_alloc();
                CU_ASSERT_PTR_NOT_NULL_FATAL(parser);
                while (parser->state != GUAC_PARSE_COMPLETE) {
                    CU_ASSERT_TRUE_FATAL(offset < f.length);
                    int consumed = guac_parser_append(parser, f.output + offset,
                            f.length - offset);
                    CU_ASSERT_TRUE_FATAL(consumed > 0);
                    CU_ASSERT_NOT_EQUAL_FATAL(parser->state, GUAC_PARSE_ERROR);
                    offset += consumed;
                }
                if (!strcmp(parser->opcode, "blob")) {
                    CU_ASSERT_EQUAL_FATAL(parser->argc, 2);
                    CU_ASSERT_EQUAL(atoi(parser->argv[0]), video->stream->index);
                    int decoded = guac_protocol_decode_base64(parser->argv[1]);
                    if (!blobs) {
                        CU_ASSERT_EQUAL_FATAL(decoded, header_length);
                        CU_ASSERT_EQUAL(memcmp(parser->argv[1], expected_header,
                                    header_length), 0);
                    }
                    else {
                        size_t chunk = length - reassembled;
                        if (chunk > GUAC_PROTOCOL_BLOB_MAX_LENGTH)
                            chunk = GUAC_PROTOCOL_BLOB_MAX_LENGTH;
                        CU_ASSERT_EQUAL_FATAL(decoded, chunk);
                        CU_ASSERT_EQUAL(memcmp(parser->argv[1], expected + reassembled,
                                    chunk), 0);
                        reassembled += chunk;
                    }
                    blobs++;
                }
                else {
                    CU_ASSERT_STRING_EQUAL(parser->opcode, "sync");
                    CU_ASSERT_EQUAL(reassembled, length);
                    CU_ASSERT_EQUAL(offset, f.length);
                    syncs++;
                }
                guac_parser_free(parser);
            }
            CU_ASSERT_EQUAL(blobs, 1 + (length + GUAC_PROTOCOL_BLOB_MAX_LENGTH - 1)
                    / GUAC_PROTOCOL_BLOB_MAX_LENGTH);
            CU_ASSERT_EQUAL(syncs, 1);
            CU_ASSERT_FALSE(video->presented);
            guac_stream* stream = video->stream;
            stream->ack_handler(f.owner, stream, avc444 ? "AVC444:1" : "AVC420:1",
                    GUAC_PROTOCOL_STATUS_SUCCESS);
            CU_ASSERT_TRUE(video->presented);
            CU_ASSERT_EQUAL(video->pending_count, 0);
            CU_ASSERT_EQUAL(video->pending_bytes, 0);
            CU_ASSERT_FALSE(video->disabled);
            free_fixture(&f);
        }
    }
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
    for (unsigned int i = 0; i < 8; i++) frame(&f);
    CU_ASSERT_FALSE(f.rdp.avc420->disabled);
    f.rdp.avc420->pending[0].sent = guac_timestamp_current()
        - GUAC_RDP_AVC420_ACK_TIMEOUT;
    frame(&f);
    CU_ASSERT_TRUE(f.rdp.avc420->disabled);
    CU_ASSERT_EQUAL(f.rdp.avc420->pending_count, 8);
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

/** Exact GAV2 fields preserve packing version, rectangles and both AU lengths. */
void test_avc420__avc444_capability_and_network_pair_header() {
    fixture f;
    init_fixture(&f, 1);
    CU_ASSERT_FALSE(guac_rdp_avc444_enabled(f.client));
    free_fixture(&f);
    init_fixture(&f, 2);
    CU_ASSERT_TRUE(guac_rdp_avc420_enabled(f.client));
    CU_ASSERT_TRUE(guac_rdp_avc444_enabled(f.client));
    ready(&f);
    CU_ASSERT_TRUE(contains(&f, GUAC_RDP_AVC444_MIMETYPE));
    CU_ASSERT_TRUE(f.rdp.avc420->ready);
    free_fixture(&f);
    unsigned char header[32];
    guac_rdp_avc444_header(header, 0x1020304, 318, 178, 1, 0, 0x506, 0x708);
    const unsigned char expected[] = {'G','A','V','2',1,2,3,4,1,62,0,178,
        0,1,0,1,0,0,5,6,0,0,7,8,0,1,0,1,0,0,0,0};
    CU_ASSERT_EQUAL(memcmp(header, expected, sizeof(header)), 0);
}

/** Real installed hooks pass the main IDR and referencing auxiliary P in order. */
void test_avc420__avc444_complete_pair_preserves_metadata_ack_and_shadow() {
    fixture f;
    init_fixture(&f, 2);
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
    RDPGFX_AVC444_BITMAP_STREAM pair = { .LC = 0, .bitstream = {
        { .length = sizeof(key), .data = (BYTE*) key,
            .meta = { .numRegionRects = 1, .regionRects = &rect } },
        { .length = sizeof(delta), .data = (BYTE*) delta,
            .meta = { .numRegionRects = 1, .regionRects = &rect } } } };
    RDPGFX_SURFACE_COMMAND command = { .surfaceId = 1, .codecId = RDPGFX_CODECID_AVC444,
        .right = 14, .bottom = 10, .extra = &pair };
    RDPGFX_START_FRAME_PDU start = { .frameId = 1 };
    RDPGFX_END_FRAME_PDU end = { .frameId = 1 };
    hook_starts = hook_surfaces = hook_ends = 0;
    guac_rdp_avc420_init_graphics(f.client, &gfx);
    CU_ASSERT_EQUAL(gfx.StartFrame(&gfx, &start), 0);
    CU_ASSERT_EQUAL(gfx.SurfaceCommand(&gfx, &command), 0);
    guac_rdp_avc420* video = f.rdp.avc420;
    CU_ASSERT_EQUAL(video->frame_length, 16 + sizeof(key) + sizeof(delta));
    CU_ASSERT_TRUE(video->frame_key);
    CU_ASSERT_FALSE(video->frame_aux_key);
    CU_ASSERT_TRUE(video->frame_avc444);
    const unsigned char rectangles[] = {0,0,0,0,0,14,0,10,0,0,0,0,0,14,0,10};
    CU_ASSERT_PTR_NOT_NULL_FATAL(video->frame);
    CU_ASSERT_EQUAL(memcmp(video->frame, rectangles, 16), 0);
    CU_ASSERT_EQUAL(memcmp(video->frame + 16, key, sizeof(key)), 0);
    CU_ASSERT_EQUAL(memcmp(video->frame + 16 + sizeof(key), delta, sizeof(delta)), 0);
    CU_ASSERT_EQUAL(gfx.EndFrame(&gfx, &end), 0);
    CU_ASSERT_EQUAL(hook_surfaces, 1);
    CU_ASSERT_TRUE(video->started);
    CU_ASSERT_EQUAL(video->pending_bytes, 16 + sizeof(key) + sizeof(delta));
    guac_stream* stream = video->stream;
    stream->ack_handler(f.owner, stream, "AVC444:1", GUAC_PROTOCOL_STATUS_SUCCESS);
    CU_ASSERT_TRUE(video->presented);
    CU_ASSERT_EQUAL(video->pending_bytes, 0);
    CU_ASSERT_FALSE(video->disabled);
    /* Changing codec after presentation must restore complete images. */
    command.codecId = RDPGFX_CODECID_AVC420;
    command.extra = &pair.bitstream[0];
    CU_ASSERT_EQUAL(gfx.StartFrame(&gfx, &start), 0);
    CU_ASSERT_EQUAL(gfx.SurfaceCommand(&gfx, &command), 0);
    CU_ASSERT_EQUAL(gfx.EndFrame(&gfx, &end), 0);
    CU_ASSERT_EQUAL(hook_surfaces, 2);
    CU_ASSERT_TRUE(video->disabled);
    CU_ASSERT_TRUE(video->refresh);
    free_fixture(&f);
}

/** Unsupported partial/v2/chroma operations always retain ordinary GDI paint. */
void test_avc420__avc444_partial_version_bounds_and_capability_fail_closed() {
    for (int invalid = 0; invalid < 9; invalid++) {
        fixture f;
        init_fixture(&f, invalid == 8 ? 1 : 2);
        ready(&f);
        rdp_freerdp_context context = { .client = f.client };
        rdpGdi gdi = { .width = 14, .height = 10, .context = &context._p };
        RdpgfxClientContext gfx = { .custom = &gdi, .StartFrame = hook_start,
            .SurfaceCommand = hook_command, .EndFrame = hook_end,
            .GetSurfaceData = hook_get_surface };
        hook_surface = (gdiGfxSurface) { .surfaceId = 1, .width = 16, .height = 16,
            .mappedWidth = 14, .mappedHeight = 10, .outputMapped = TRUE,
            .outputTargetWidth = 14, .outputTargetHeight = 10 };
        RECTANGLE_16 main_rect = { .right = 14, .bottom = 10 };
        RECTANGLE_16 aux_rect = main_rect;
        RDPGFX_AVC444_BITMAP_STREAM pair = { .LC = 0, .bitstream = {
            { .length = sizeof(key), .data = (BYTE*) key,
                .meta = { .numRegionRects = 1, .regionRects = &main_rect } },
            { .length = sizeof(delta), .data = (BYTE*) delta,
                .meta = { .numRegionRects = 1, .regionRects = &aux_rect } } } };
        RDPGFX_SURFACE_COMMAND command = { .surfaceId = 1,
            .codecId = RDPGFX_CODECID_AVC444, .right = 14, .bottom = 10, .extra = &pair };
        switch (invalid) {
            case 0: pair.LC = 1; break;
            case 1: pair.LC = 2; break;
            case 2: command.codecId = RDPGFX_CODECID_AVC444v2; break;
            case 3: main_rect.right = 8; break;
            case 4: aux_rect.right = 8; break;
            case 5: pair.bitstream[0].length = GUAC_RDP_AVC420_MAX_FRAME + 1; break;
            case 6: command.extra = NULL; break;
            case 7: pair.bitstream[1].length = GUAC_RDP_AVC420_MAX_FRAME; break;
        }
        RDPGFX_START_FRAME_PDU start = { .frameId = 1 };
        RDPGFX_END_FRAME_PDU end = { .frameId = 1 };
        hook_surfaces = 0;
        guac_rdp_avc420_init_graphics(f.client, &gfx);
        CU_ASSERT_EQUAL(gfx.StartFrame(&gfx, &start), 0);
        CU_ASSERT_EQUAL(gfx.SurfaceCommand(&gfx, &command), 0);
        CU_ASSERT_PTR_NULL(f.rdp.avc420->frame);
        CU_ASSERT_FALSE(f.rdp.avc420->supported_frame);
        CU_ASSERT_EQUAL(gfx.EndFrame(&gfx, &end), 0);
        CU_ASSERT_EQUAL(hook_surfaces, 1);
        CU_ASSERT_FALSE(f.rdp.avc420->started);
        CU_ASSERT_FALSE(guac_rdp_avc420_suppress_paint(f.client));
        free_fixture(&f);
    }
}

/** Host-selected AVC420 must remain playable for an AVC444-capable browser. */
void test_avc420__avc444_capability_opens_actual_avc420_first_frame_mime() {
    fixture f;
    init_fixture(&f, 2);
    guac_rdp_avc420* video = f.rdp.avc420;
    /* Production SurfaceCommand sets these before opening the first stream. */
    video->frame = malloc(sizeof(key));
    CU_ASSERT_PTR_NOT_NULL_FATAL(video->frame);
    memcpy(video->frame, key, sizeof(key));
    video->frame_length = sizeof(key);
    video->frame_avc444 = 0;
    video->frame_key = 1;
    video->width = video->height = 16;
    video->supported_frame = video->commands = 1;
    ready(&f);
    CU_ASSERT_TRUE(video->avc444);
    CU_ASSERT_FALSE(video->stream_avc444);
    CU_ASSERT_TRUE(contains(&f, GUAC_RDP_AVC420_MIMETYPE));
    CU_ASSERT_FALSE(contains(&f, GUAC_RDP_AVC444_MIMETYPE));
    guac_rdp_avc420_send_frame(f.client);
    CU_ASSERT_TRUE(video->started);
    guac_stream* stream = video->stream;
    stream->ack_handler(f.owner, stream, "AVC420:1", GUAC_PROTOCOL_STATUS_SUCCESS);
    CU_ASSERT_TRUE(video->presented);
    CU_ASSERT_FALSE(video->disabled);
    free_fixture(&f);
}

/** A legacy or fabricated ACK cannot confirm an AVC444 stream presentation. */
void test_avc420__avc444_ack_rejects_legacy_prefix_and_unpresented_sequence() {
    for (int pending = 0; pending < 3; pending++) {
        fixture f;
        init_fixture(&f, 2);
        guac_rdp_avc420_open(f.client);
        guac_rdp_avc420* video = f.rdp.avc420;
        guac_stream* stream = video->stream;
        CU_ASSERT_PTR_NOT_NULL_FATAL(stream);
        if (pending) {
            stream->ack_handler(f.owner, stream, "AVC444:ready", GUAC_PROTOCOL_STATUS_SUCCESS);
            video->pending[0] = (guac_rdp_avc420_pending) { .sequence = 1, .bytes = 16 };
            video->pending_count = 1;
            video->pending_bytes = 16;
        }
        stream->ack_handler(f.owner, stream,
                !pending ? "AVC420:ready" : (pending == 1 ? "AVC420:1" : "AVC444:2"),
                GUAC_PROTOCOL_STATUS_SUCCESS);
        CU_ASSERT_TRUE(video->disabled);
        CU_ASSERT_FALSE(video->presented);
        CU_ASSERT_TRUE(video->refresh);
        free_fixture(&f);
    }
}

/** Browser diagnostics accept only exact known codes and never echo peer data. */
void test_avc420__avc444_failure_reasons_are_static_and_allowlisted() {
    static const struct { const char* ack; const char* reason; } cases[] = {
        {"AVC444:fallback:invalid-stream", "browser AVC444 stream validation failed"},
        {"AVC444:fallback:unsupported-config", "browser AVC444 configuration unsupported"},
        {"AVC444:fallback:decoder-error", "browser AVC444 decoder error"},
        {"AVC444:fallback:native-layout", "browser AVC444 native YUV layout unsupported"},
        {"AVC444:fallback:native-copy", "browser AVC444 native YUV copy failed"},
        {"AVC444:fallback:renderer-error", "browser AVC444 reconstruction failed"},
        {"AVC444:fallback:context-lost", "browser AVC444 graphics context lost"},
        {"AVC444:fallback:frame-timeout", "browser AVC444 frame presentation deadline exceeded"},
        {"AVC444:fallback:assembly-timeout", "browser AVC444 frame assembly deadline exceeded"},
        {"AVC444:fallback:backlog-limit", "browser AVC444 queue safety limit exceeded"},
        {"AVC444:fallback:presentation-error", "browser AVC444 ordered presentation failed"},
        {"AVC444:fallback", "browser decoder rejected frame or invalid ACK"},
        {"AVC444:fallback:native-copy\nsecret-user-data", "browser decoder rejected frame or invalid ACK"},
        {"AVC420:fallback:native-copy", "browser decoder rejected frame or invalid ACK"},
        {"AVC444:fallback:unknown", "browser decoder rejected frame or invalid ACK"}
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        fixture f;
        init_fixture(&f, 2);
        ready(&f);
        guac_rdp_avc420* video = f.rdp.avc420;
        guac_stream* stream = video->stream;
        stream->ack_handler(f.owner, stream, (char*) cases[i].ack,
                GUAC_PROTOCOL_STATUS_SERVER_ERROR);
        CU_ASSERT_TRUE(video->disabled);
        CU_ASSERT_TRUE(video->refresh);
        CU_ASSERT_STRING_EQUAL(video->reason, cases[i].reason);
        CU_ASSERT_FALSE(video->presented);
        free_fixture(&f);
    }
}

typedef struct pacing_wake {
    fixture* f;
    int action;
} pacing_wake;

static void* wake_pacing(void* data) {
    pacing_wake* wake = data;
    guac_timestamp_msleep(30);
    guac_rdp_avc420* video = wake->f->rdp.avc420;
    if (wake->action == 1)
        guac_rdp_avc420_stop(wake->f->client, "test cancellation");
    else if (wake->action == 2)
        guac_rdp_avc420_leave(wake->f->client, wake->f->owner);
    else if (wake->action == 3) {
        for (int i = 0; i < 10; i++) {
            pthread_mutex_lock(&video->lock);
            pthread_cond_broadcast(&video->ready_changed);
            pthread_mutex_unlock(&video->lock);
            guac_timestamp_msleep(20);
        }
    }
    else {
        char ack[32];
        snprintf(ack, sizeof(ack), "%s:1", video->stream_avc444 ? "AVC444" : "AVC420");
        guac_stream* stream = video->stream;
        stream->ack_handler(wake->f->owner, stream, ack, GUAC_PROTOCOL_STATUS_SUCCESS);
    }
    return NULL;
}

/** A slow first presentation earns credit without skipping dependent AUs. */
void test_avc420__startup_and_steady_windows_wait_for_ordered_presentation_credit() {
    for (int avc444 = 0; avc444 <= 1; avc444++) {
        for (int presented = 0; presented <= 1; presented++) {
            fixture f;
            init_fixture(&f, avc444 ? 2 : 1);
            ready(&f);
            guac_rdp_avc420* video = f.rdp.avc420;
            video->presented = presented;
            unsigned int window = avc444 ? (presented ? 4 : 2) : (presented ? 8 : 4);
            for (unsigned int i = 0; i < window; i++) access_unit(&f, !i);
            CU_ASSERT_EQUAL(video->pending_count, window);
            CU_ASSERT_EQUAL(video->sequence, window);
            CU_ASSERT_EQUAL(video->presented, presented);
            pacing_wake wake = { .f = &f };
            pthread_t thread;
            CU_ASSERT_EQUAL_FATAL(pthread_create(&thread, NULL, wake_pacing, &wake), 0);
            access_unit(&f, 0);
            pthread_join(thread, NULL);
            CU_ASSERT_FALSE(video->disabled);
            CU_ASSERT_TRUE(video->presented);
            CU_ASSERT_EQUAL(video->pacing_events, 1);
            CU_ASSERT_EQUAL(video->pending_head, 1);
            CU_ASSERT_EQUAL(video->pending_count, window);
            CU_ASSERT_EQUAL(video->sequence, window + 1);
            unsigned int tail = (video->pending_head + video->pending_count - 1)
                % GUAC_RDP_AVC420_MAX_PENDING;
            CU_ASSERT_EQUAL(video->pending[tail].sequence, window + 1);
            CU_ASSERT_EQUAL(video->pending[tail].bytes,
                    avc444 ? 16 + 2 * sizeof(delta) : sizeof(delta));
            CU_ASSERT_PTR_NULL(video->frame);
            CU_ASSERT_EQUAL(video->frame_length, 0);
            free_fixture(&f);
        }
    }
}

/** Byte pressure uses the same bounded wait even below the frame window. */
void test_avc420__byte_credit_recovers_without_exceeding_the_existing_limit() {
    fixture f;
    init_fixture(&f, 1);
    ready(&f);
    frame(&f);
    guac_rdp_avc420* video = f.rdp.avc420;
    video->pending[0].bytes = video->pending_bytes
        = GUAC_RDP_AVC420_MAX_PENDING_BYTES - 1;
    pacing_wake wake = { .f = &f };
    pthread_t thread;
    CU_ASSERT_EQUAL_FATAL(pthread_create(&thread, NULL, wake_pacing, &wake), 0);
    access_unit(&f, 0);
    pthread_join(thread, NULL);
    CU_ASSERT_FALSE(video->disabled);
    CU_ASSERT_EQUAL(video->pacing_events, 1);
    CU_ASSERT_EQUAL(video->sequence, 2);
    CU_ASSERT_EQUAL(video->pending_count, 1);
    CU_ASSERT_EQUAL(video->pending_bytes, sizeof(delta));
    free_fixture(&f);
}

/** Unrelated wakes never restart the existing oldest-picture deadline. */
void test_avc420__pacing_deadline_is_fixed_and_stop_or_owner_leave_wake_waiters() {
    for (int action = 1; action <= 3; action++) {
        fixture f;
        init_fixture(&f, 1);
        ready(&f);
        for (int i = 0; i < 4; i++) access_unit(&f, !i);
        guac_rdp_avc420* video = f.rdp.avc420;
        if (action == 3)
            video->pending[0].sent = guac_timestamp_current()
                - GUAC_RDP_AVC420_ACK_TIMEOUT + 120;
        pacing_wake wake = { .f = &f, .action = action };
        pthread_t thread;
        CU_ASSERT_EQUAL_FATAL(pthread_create(&thread, NULL, wake_pacing, &wake), 0);
        guac_timestamp started = guac_timestamp_current();
        access_unit(&f, 0);
        guac_timestamp elapsed = guac_timestamp_current() - started;
        pthread_join(thread, NULL);
        CU_ASSERT_TRUE(video->disabled);
        CU_ASSERT_TRUE(video->refresh);
        CU_ASSERT_EQUAL(video->sequence, 4);
        CU_ASSERT_EQUAL(video->pending_count, 4);
        CU_ASSERT_PTR_NULL(video->frame);
        CU_ASSERT_TRUE(elapsed < 1000);
        if (action == 3)
            CU_ASSERT_STRING_EQUAL(video->reason,
                    "browser video pacing presentation deadline exceeded");
        free_fixture(&f);
    }
}

/** Legacy failure ACKs work, while untrusted strings never become log reasons. */
void test_avc420__avc420_failure_reasons_are_static_and_allowlisted() {
    static const struct { const char* ack; const char* reason; } cases[] = {
        {"AVC420:fallback:invalid-stream", "browser AVC420 stream validation failed"},
        {"AVC420:fallback:unsupported-config", "browser AVC420 configuration unsupported"},
        {"AVC420:fallback:decoder-error", "browser AVC420 decoder error"},
        {"AVC420:fallback:frame-timeout", "browser AVC420 frame presentation deadline exceeded"},
        {"AVC420:fallback:assembly-timeout", "browser AVC420 frame assembly deadline exceeded"},
        {"AVC420:fallback:backlog-limit", "browser AVC420 queue safety limit exceeded"},
        {"AVC420:fallback:presentation-error", "browser AVC420 ordered presentation failed"},
        {"AVC420:fallback", "browser decoder rejected frame or invalid ACK"},
        {"AVC420:fallback:decoder-error\nsecret-user-data", "browser decoder rejected frame or invalid ACK"},
        {"AVC444:fallback:decoder-error", "browser decoder rejected frame or invalid ACK"},
        {"AVC420:fallback:unknown", "browser decoder rejected frame or invalid ACK"}
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        fixture f;
        init_fixture(&f, 1);
        ready(&f);
        guac_rdp_avc420* video = f.rdp.avc420;
        video->stream->ack_handler(f.owner, video->stream, (char*) cases[i].ack,
                GUAC_PROTOCOL_STATUS_SERVER_ERROR);
        CU_ASSERT_TRUE(video->disabled);
        CU_ASSERT_TRUE(video->refresh);
        CU_ASSERT_STRING_EQUAL(video->reason, cases[i].reason);
        free_fixture(&f);
    }
}
