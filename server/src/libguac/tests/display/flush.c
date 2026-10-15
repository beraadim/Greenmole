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

#include "assert-signal.h"

#include <CUnit/CUnit.h>

#include <limits.h>
#include <stdint.h>
#include <string.h>

/* Exercise the production snapshot helper without creating rendering threads
 * or sockets. Rename public entrypoints to isolate this copy from libguac. */
#define guac_display_end_frame flush_test_end_frame
#define guac_display_end_mouse_frame flush_test_end_mouse_frame
#define guac_display_end_multiple_frames flush_test_end_multiple_frames
#include "../../display-flush.c"
#undef guac_display_end_frame
#undef guac_display_end_mouse_frame
#undef guac_display_end_multiple_frames

/** Initializes a padded, externally-owned source and its initial snapshot. */
static void snapshot_init(guac_display_layer* layer, unsigned char* source,
        int width, int height, size_t stride) {

    *layer = (guac_display_layer) { 0 };
    layer->pending_frame = (guac_display_layer_state) {
        .width = width,
        .height = height,
        .buffer = source,
        .buffer_width = width,
        .buffer_height = height,
        .buffer_stride = stride,
        .buffer_is_external = 1
    };
    layer->last_frame.width = width;
    layer->last_frame.height = height;
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(layer),
            height * stride);
    CU_ASSERT_EQUAL(memcmp(layer->last_frame.buffer, source, height * stride), 0);

}

/** Small updates copy their pixels, leaving other pixels and padding alone. */
void test_display__snapshot_copies_only_dirty_pixels() {

    unsigned char source[6 * 40];
    memset(source, 0x11, sizeof(source));
    guac_display_layer layer;
    snapshot_init(&layer, source, 8, 6, 40);

    /* Deliberately change even unreported pixels and padding, so a full copy
     * cannot accidentally satisfy the expected snapshot. */
    memset(source, 0x22, sizeof(source));
    layer.pending_frame.dirty = (guac_rect) { 2, 1, 5, 4 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 3 * 3 * 4);

    for (int y = 0; y < 6; y++) {
        for (int x = 0; x < 40; x++) {
            unsigned char expected = y >= 1 && y < 4 && x >= 8 && x < 20
                ? 0x22 : 0x11;
            CU_ASSERT_EQUAL(layer.last_frame.buffer[y * 40 + x], expected);
        }
    }

    CU_ASSERT_EQUAL(layer.last_frame.dirty.left, 2);
    CU_ASSERT_EQUAL(layer.last_frame.dirty.bottom, 4);
    CU_ASSERT_EQUAL(guac_rect_is_empty(&layer.pending_frame.dirty), 1);
    guac_mem_free(layer.last_frame.buffer);

}

/** Disjoint changes retain both ends of the dirty region's bounding union. */
void test_display__snapshot_retains_disjoint_dirty_changes() {

    unsigned char source[8 * 8 * 4] = { 0 };
    guac_display_layer layer;
    snapshot_init(&layer, source, 8, 8, 32);

    guac_rect first = { 1, 1, 2, 2 };
    guac_rect second = { 6, 5, 7, 6 };
    memset(source + 1 * 32 + 1 * 4, 0x11, 4);
    memset(source + 5 * 32 + 6 * 4, 0x22, 4);
    guac_rect_extend(&layer.pending_frame.dirty, &first);
    guac_rect_extend(&layer.pending_frame.dirty, &second);

    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 6 * 5 * 4);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, source, sizeof(source)), 0);
    guac_mem_free(layer.last_frame.buffer);

}

/** Extreme caller-supplied coordinates are clipped before offset arithmetic. */
void test_display__snapshot_clips_dirty_bounds() {

    unsigned char source[4 * 24];
    memset(source, 0, sizeof(source));
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 24);
    memset(source, 0x33, sizeof(source));
    layer.pending_frame.dirty = (guac_rect) { INT_MIN, INT_MIN, INT_MAX, INT_MAX };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 4 * 4 * 4);
    for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 24; x++)
            CU_ASSERT_EQUAL(layer.last_frame.buffer[y * 24 + x], x < 16 ? 0x33 : 0);
    }

    layer.pending_frame.dirty = (guac_rect) { 100, 100, INT_MAX, INT_MAX };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 0);
    CU_ASSERT_EQUAL(guac_rect_is_empty(&layer.last_frame.dirty), 1);
    layer.pending_frame.dirty = (guac_rect) { INT_MIN, INT_MIN, -1, -1 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 0);
    CU_ASSERT_EQUAL(guac_rect_is_empty(&layer.last_frame.dirty), 1);

    /* Hidden backing pixels and padding are outside a stable visible layer. */
    layer.pending_frame.width = layer.last_frame.width = 2;
    layer.pending_frame.height = layer.last_frame.height = 2;
    memset(source, 0x44, sizeof(source));
    layer.pending_frame.dirty = (guac_rect) { 0, 0, 20, 20 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 2 * 2 * 4);
    CU_ASSERT_EQUAL(layer.last_frame.buffer[0], 0x44);
    CU_ASSERT_EQUAL(layer.last_frame.buffer[8], 0x33);
    CU_ASSERT_EQUAL(layer.last_frame.buffer[2 * 24], 0x33);
    guac_mem_free(layer.last_frame.buffer);

}

/** A clean frame does not copy data or retain the previous dirty rectangle. */
void test_display__snapshot_clean_frames_clear_dirty_state() {

    unsigned char source[64] = { 0 };
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);
    layer.pending_frame.dirty = (guac_rect) { 1, 1, 2, 2 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 4);
    memset(source, 0x44, sizeof(source));
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 0);
    CU_ASSERT_EQUAL(guac_rect_is_empty(&layer.last_frame.dirty), 1);
    for (int i = 0; i < 64; i++)
        CU_ASSERT_EQUAL(layer.last_frame.buffer[i], 0);
    guac_mem_free(layer.last_frame.buffer);

}

/** Replacing an external source of the same size requires a complete copy. */
void test_display__snapshot_replaced_buffers_copy_every_byte() {

    unsigned char source[64] = { 0 };
    unsigned char replacement[64];
    memset(replacement, 0x55, sizeof(replacement));
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);
    layer.pending_frame.buffer = replacement;
    layer.pending_frame_buffer_replaced = 1;
    layer.pending_frame.dirty = (guac_rect) { 1, 1, 2, 2 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 64);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, replacement, 64), 0);
    CU_ASSERT_EQUAL(layer.pending_frame_buffer_replaced, 0);

    memset(replacement, 0x66, sizeof(replacement));
    layer.pending_frame.dirty = (guac_rect) { 1, 1, 2, 2 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 4);
    CU_ASSERT_EQUAL(layer.last_frame.buffer[0], 0x55);
    guac_mem_free(layer.last_frame.buffer);

}

/** Detaching an external source must not read it; reattaching refreshes it. */
void test_display__snapshot_detached_buffers_are_safe() {

    unsigned char source[64] = { 0 };
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);
    layer.pending_frame.buffer = NULL;
    layer.pending_frame.dirty = (guac_rect) { 1, 1, 2, 2 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 0);
    CU_ASSERT_EQUAL(guac_rect_is_empty(&layer.last_frame.dirty), 1);

    memset(source, 0x77, sizeof(source));
    layer.pending_frame.buffer = source;
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 64);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, source, 64), 0);
    guac_mem_free(layer.last_frame.buffer);

}

/** New allocation geometry or stride copies the entire new backing buffer. */
void test_display__snapshot_backing_geometry_changes_copy_fully() {

    unsigned char source[64] = { 0 };
    unsigned char replacement[6 * 24];
    memset(replacement, 0x88, sizeof(replacement));
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);

    layer.pending_frame.buffer = replacement;
    layer.pending_frame.buffer_width = 5;
    layer.pending_frame.buffer_height = 6;
    layer.pending_frame.buffer_stride = 24;
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), sizeof(replacement));
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, replacement, sizeof(replacement)), 0);
    CU_ASSERT_EQUAL(layer.last_frame.buffer_width, 5);
    CU_ASSERT_EQUAL(layer.last_frame.buffer_height, 6);
    CU_ASSERT_EQUAL(layer.last_frame.buffer_stride, 24);

    /* Stride-only changes also reinitialize padding and every row. */
    layer.pending_frame.buffer_stride = 20;
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 6 * 20);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, replacement, 6 * 20), 0);
    guac_mem_free(layer.last_frame.buffer);

}

/** Exposing more of a backing allocation must preserve its hidden pixels. */
void test_display__snapshot_visible_geometry_changes_copy_fully() {

    unsigned char source[64] = { 0 };
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);
    layer.last_frame.width = 2;
    layer.last_frame.height = 2;
    memset(source, 0x99, sizeof(source));
    layer.pending_frame.dirty = (guac_rect) { 1, 1, 2, 2 };
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 64);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, source, 64), 0);
    guac_mem_free(layer.last_frame.buffer);

}

/** Multiple raw buffer swaps must retain the full-copy requirement. */
void test_display__snapshot_tracks_external_replacements_between_commits() {

    unsigned char source[64] = { 0 };
    unsigned char replacement[64] = { 0 };
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    guac_rwlock_init(&display->pending_frame.lock);
    layer.display = display;
    layer.pending_frame_cells_width = layer.pending_frame_cells_height = 1;

    guac_display_layer_raw_context* context = guac_display_layer_open_raw(&layer);
    context->buffer = replacement;
    guac_display_layer_close_raw(&layer, context);
    CU_ASSERT_EQUAL(layer.pending_frame_buffer_replaced, 1);

    context = guac_display_layer_open_raw(&layer);
    context->buffer = source;
    guac_display_layer_close_raw(&layer, context);
    CU_ASSERT_EQUAL(layer.pending_frame_buffer_replaced, 1);
    memset(source, 0xAB, sizeof(source));
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 64);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, source, 64), 0);

    guac_rwlock_destroy(&display->pending_frame.lock);
    guac_mem_free(display);
    guac_mem_free(layer.last_frame.buffer);

}

/** An internal resize away and back still replaces the source allocation. */
void test_display__snapshot_tracks_internal_replacements_between_commits() {

    size_t buffer_size = 64 * 64 * 4;
    unsigned char* source = guac_mem_zalloc(buffer_size);
    CU_ASSERT_PTR_NOT_NULL_FATAL(source);
    guac_display_layer layer;
    snapshot_init(&layer, source, 64, 64, 64 * 4);
    layer.pending_frame.buffer_is_external = 0;
    layer.pending_frame_cells_width = layer.pending_frame_cells_height = 1;
    layer.pending_frame_cells = guac_mem_zalloc(sizeof(guac_display_layer_cell));
    CU_ASSERT_PTR_NOT_NULL_FATAL(layer.pending_frame_cells);
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    guac_rwlock_init(&display->pending_frame.lock);
    layer.display = display;

    guac_display_layer_resize(&layer, 128, 64);
    guac_display_layer_resize(&layer, 64, 64);
    CU_ASSERT_EQUAL(layer.pending_frame_buffer_replaced, 1);
    memset(layer.pending_frame.buffer, 0xBC, buffer_size);
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), buffer_size);
    CU_ASSERT_EQUAL(memcmp(layer.last_frame.buffer, layer.pending_frame.buffer,
                buffer_size), 0);

    guac_rwlock_destroy(&display->pending_frame.lock);
    guac_mem_free(display);
    guac_mem_free(layer.pending_frame_cells);
    guac_mem_free(layer.pending_frame.buffer);
    guac_mem_free(layer.last_frame.buffer);

}

/** Empty external layouts must not form or dereference null snapshot pointers. */
void test_display__snapshot_handles_empty_backing_buffers() {

    unsigned char source = 0;
    guac_display_layer layer = { 0 };
    layer.pending_frame.buffer = &source;
    layer.pending_frame.buffer_is_external = 1;
    CU_ASSERT_EQUAL(PFW_LFW_guac_display_layer_commit_buffer(&layer), 0);
    CU_ASSERT_EQUAL(guac_rect_is_empty(&layer.last_frame.dirty), 1);
    guac_mem_free(layer.last_frame.buffer);

}

/** Malformed external layouts fail before producing out-of-bounds pointers. */
void test_display__snapshot_rejects_invalid_buffer_layouts() {

    unsigned char source[64] = { 0 };
    guac_display_layer layer;
    snapshot_init(&layer, source, 4, 4, 16);
    layer.pending_frame.buffer_stride = 15;
    ASSERT_SIGNALLED(SIGABRT, PFW_LFW_guac_display_layer_commit_buffer(&layer));

    layer.pending_frame.buffer_stride = SIZE_MAX;
    ASSERT_SIGNALLED(SIGABRT, PFW_LFW_guac_display_layer_commit_buffer(&layer));
    guac_mem_free(layer.last_frame.buffer);

}
