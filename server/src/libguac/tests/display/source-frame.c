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

#include <CUnit/CUnit.h>

#include "../../display-priv.h"
#include "guacamole/mem.h"
#include "guacamole/timestamp.h"

/** Source markers are safe inside a raw painting context's existing lock. */
void test_display__source_markers_allow_reentrant_paint_lock() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    guac_display_render_thread thread = { .display = display };
    guac_rwlock_init(&display->pending_frame.lock);
    guac_flag_init(&thread.state);

    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
    guac_display_render_thread_notify_frame_start(&thread);
    CU_ASSERT_EQUAL(display->source_frame_open, 1);
    CU_ASSERT_EQUAL(thread.source_frame_open, 1);
    guac_timestamp first_start = thread.source_frame_start;
    guac_display_render_thread_notify_frame_start(&thread);
    CU_ASSERT_EQUAL(thread.source_frame_start, first_start);
    guac_display_render_thread_notify_frame(&thread);
    CU_ASSERT_EQUAL(display->source_frame_open, 0);
    CU_ASSERT_EQUAL(thread.source_frame_open, 0);
    CU_ASSERT_EQUAL(thread.frames, 1);

    guac_display_render_thread_notify_frame_start(&thread);
    guac_display_render_thread_reset_frame(&thread);
    CU_ASSERT_EQUAL(display->source_frame_open, 0);
    CU_ASSERT_EQUAL(thread.source_frame_open, 0);
    CU_ASSERT_EQUAL(thread.frames, 1);
    guac_rwlock_release_lock(&display->pending_frame.lock);

    guac_flag_destroy(&thread.state);
    guac_rwlock_destroy(&display->pending_frame.lock);
    guac_mem_free(display);
}

/** Independent worker retries must retain incomplete source-frame pixels. */
void test_display__deferred_flush_respects_source_frame_gate() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    guac_rwlock_init(&display->pending_frame.lock);
    display->source_frame_open = 1;
    /* A future start avoids relying on the host scheduler finishing this
     * deterministic guard test within the production 100 ms timeout. */
    display->source_frame_start = guac_timestamp_current() + 1000;
    guac_display_end_multiple_frames(display, 3);
    CU_ASSERT_EQUAL(display->source_frame_open, 1);
    CU_ASSERT_EQUAL(display->pending_frame.frames, 3);
    CU_ASSERT_EQUAL(display->last_frame.frames, 0);
    guac_rwlock_destroy(&display->pending_frame.lock);
    guac_mem_free(display);
}
