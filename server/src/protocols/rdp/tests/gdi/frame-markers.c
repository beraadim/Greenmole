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

/* FreeRDP 2's inline color helpers expand WinPR logging macros containing
 * __FUNCTION__, a GNU extension. Isolate that third-party header from the
 * pedantic check; the included GDI implementation and tests remain strict. */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include <freerdp/codec/color.h>
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

/* Exercise the actual GDI callbacks with a deterministic render observer.
 * The rest of gdi.c is renamed so these callbacks do not replace the linked
 * RDP plugin's exported functions in this test process. */
#define guac_display_render_thread_notify_frame_start marker_test_notify_start
#define guac_display_render_thread_notify_frame marker_test_notify_end
#define guac_display_render_thread_reset_frame marker_test_reset
#define guac_rdp_gdi_mark_frame marker_test_mark_frame
#define guac_rdp_gdi_frame_marker marker_test_order
#define guac_rdp_gdi_surface_frame_marker marker_test_surface
#define guac_rdp_gdi_begin_paint marker_test_begin_paint
#define guac_rdp_gdi_end_paint marker_test_end_paint
#define guac_rdp_gdi_desktop_resize marker_test_resize
#include "../../gdi.c"

#include <CUnit/CUnit.h>
#include <freerdp/settings.h>
#include <string.h>

static int starts;
static int ends;
static int acknowledgements;
static UINT32 acknowledged_id;

void marker_test_notify_start(guac_display_render_thread* render_thread) {
    starts++;
}

void marker_test_notify_end(guac_display_render_thread* render_thread) {
    ends++;
}

void marker_test_reset(guac_display_render_thread* render_thread) {
}

static BOOL acknowledge_frame(rdpContext* context, UINT32 frame_id) {
    acknowledgements++;
    acknowledged_id = frame_id;
    return TRUE;
}

static void init_context(rdp_freerdp_context* context, guac_client* client,
        guac_rdp_client* rdp_client, rdpUpdate* update, int acknowledge) {
    memset(context, 0, sizeof(*context));
    memset(client, 0, sizeof(*client));
    memset(rdp_client, 0, sizeof(*rdp_client));
    memset(update, 0, sizeof(*update));
    starts = ends = acknowledgements = 0;
    acknowledged_id = 0;
    /* The scheduler is mocked and never dereferences this observer token. */
    rdp_client->render_thread = (guac_display_render_thread*) rdp_client;
    client->data = rdp_client;
    context->client = client;
    context->_p.update = update;
    context->_p.settings = freerdp_settings_new(0);
    CU_ASSERT_PTR_NOT_NULL_FATAL(context->_p.settings);
#ifdef HAVE_SETTERS_GETTERS
    freerdp_settings_set_uint32(context->_p.settings, FreeRDP_FrameAcknowledge,
            acknowledge);
#else
    context->_p.settings->FrameAcknowledge = acknowledge;
#endif
    update->SurfaceFrameAcknowledge = acknowledge_frame;
}

void test_gdi__surface_frames_only_acknowledge_completed_frames() {
    rdp_freerdp_context context;
    guac_client client;
    guac_rdp_client rdp_client;
    rdpUpdate update;
    init_context(&context, &client, &rdp_client, &update, 1);

    SURFACE_FRAME_MARKER marker = {0};
    marker.frameId = 27;
    marker.frameAction = SURFACECMD_FRAMEACTION_BEGIN;
    CU_ASSERT_TRUE(marker_test_surface(&context._p, &marker));
    CU_ASSERT_EQUAL(starts, 1);
    CU_ASSERT_EQUAL(ends, 0);
    CU_ASSERT_EQUAL(acknowledgements, 0);

    marker.frameAction = SURFACECMD_FRAMEACTION_END;
    CU_ASSERT_TRUE(marker_test_surface(&context._p, &marker));
    CU_ASSERT_EQUAL(starts, 1);
    CU_ASSERT_EQUAL(ends, 1);
    CU_ASSERT_EQUAL(acknowledgements, 1);
    CU_ASSERT_EQUAL(acknowledged_id, 27);
    freerdp_settings_free(context._p.settings);
}

void test_gdi__order_markers_forward_both_boundaries_without_surface_acks() {
    rdp_freerdp_context context;
    guac_client client;
    guac_rdp_client rdp_client;
    rdpUpdate update;
    init_context(&context, &client, &rdp_client, &update, 0);

    FRAME_MARKER_ORDER marker = {0};
    marker.action = FRAME_START;
    CU_ASSERT_TRUE(marker_test_order(&context._p, &marker));
    marker.action = FRAME_END;
    CU_ASSERT_TRUE(marker_test_order(&context._p, &marker));
    CU_ASSERT_EQUAL(starts, 1);
    CU_ASSERT_EQUAL(ends, 1);
    CU_ASSERT_EQUAL(acknowledgements, 0);

    SURFACE_FRAME_MARKER surface = {0};
    surface.frameAction = SURFACECMD_FRAMEACTION_END;
    CU_ASSERT_TRUE(marker_test_surface(&context._p, &surface));
    CU_ASSERT_EQUAL(ends, 2);
    CU_ASSERT_EQUAL(acknowledgements, 0);
    freerdp_settings_free(context._p.settings);
}

void test_gdi__startup_markers_do_not_access_an_uncreated_render_thread() {
    rdp_freerdp_context context;
    guac_client client;
    guac_rdp_client rdp_client;
    rdpUpdate update;
    init_context(&context, &client, &rdp_client, &update, 0);
    rdp_client.render_thread = NULL;
    marker_test_mark_frame(&context._p, 1);
    marker_test_mark_frame(&context._p, 0);
    CU_ASSERT_EQUAL(starts, 0);
    CU_ASSERT_EQUAL(ends, 0);
    freerdp_settings_free(context._p.settings);
}
