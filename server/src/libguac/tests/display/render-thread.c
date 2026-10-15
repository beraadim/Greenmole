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

/* Exercise the real render loop using a virtual clock and scheduled flag
 * changes. This tests latency and backpressure without depending on thread
 * scheduling or making timing assertions against the system clock. Rename the
 * exported entrypoints to keep this copy isolated from the linked library. */
#define guac_timestamp_current render_test_timestamp_current
#define guac_timestamp_msleep render_test_msleep
#define guac_flag_wait_and_lock render_test_wait_and_lock
#define guac_flag_timedwait_and_lock render_test_timedwait_and_lock
#define guac_flag_clear render_test_clear
#define guac_flag_unlock render_test_unlock
#define guac_client_get_processing_lag render_test_processing_lag
#define guac_display_end_multiple_frames render_test_end_frames
#define guac_rwlock_acquire_write_lock render_test_write_lock
#define guac_rwlock_release_lock render_test_release_lock
#define guac_thread_name_set render_test_thread_name
#define guac_display_render_thread_create render_test_create
#define guac_display_render_thread_destroy render_test_destroy
#define guac_display_render_thread_notify_modified render_test_notify_modified
#define guac_display_render_thread_notify_frame render_test_notify_frame
#define guac_display_render_thread_notify_user_moved_mouse render_test_notify_mouse

#include "../../display-render-thread.c"

#undef guac_timestamp_current
#undef guac_timestamp_msleep
#undef guac_flag_wait_and_lock
#undef guac_flag_timedwait_and_lock
#undef guac_flag_clear
#undef guac_flag_unlock
#undef guac_client_get_processing_lag
#undef guac_display_end_multiple_frames
#undef guac_rwlock_acquire_write_lock
#undef guac_rwlock_release_lock
#undef guac_thread_name_set
#undef guac_display_render_thread_create
#undef guac_display_render_thread_destroy
#undef guac_display_render_thread_notify_modified
#undef guac_display_render_thread_notify_frame
#undef guac_display_render_thread_notify_user_moved_mouse

/** A change in render state scheduled against the virtual clock. */
typedef struct render_test_event {
    int time;
    unsigned int flags;
    unsigned int frames;
    int cursor_x;
} render_test_event;

static guac_timestamp current_time;
static int processing_lag;
static int state_locked;
static int flush_count;
static int flushed_frames;
static int flushed_cursor_x;
static guac_display_render_thread* active_thread;
static const render_test_event* events;
static int event_count;
static int next_event;

guac_timestamp render_test_timestamp_current() {
    return current_time;
}

int render_test_processing_lag(guac_client* client) {
    return processing_lag;
}

void render_test_thread_name(const char* name) {
    /* Do not rename the test runner's actual thread. */
}

int render_test_write_lock(guac_rwlock* lock) {
    return 0;
}

int render_test_release_lock(guac_rwlock* lock) {
    return 0;
}

void render_test_unlock(guac_flag* flag) {
    CU_ASSERT_EQUAL(state_locked, 1);
    state_locked = 0;
}

void render_test_clear(guac_flag* flag, unsigned int flags) {
    CU_ASSERT_EQUAL(state_locked, 1);
    flag->value &= ~flags;
}

int render_test_timedwait_and_lock(guac_flag* flag, unsigned int flags,
        unsigned int timeout) {

    CU_ASSERT_EQUAL(state_locked, 0);
    guac_timestamp deadline = current_time + timeout;

    /* Other flags may change during a wait without satisfying its predicate.
     * In particular, a ready frame must not interrupt client lag compensation. */
    while (!(flag->value & flags) && next_event < event_count
            && events[next_event].time <= deadline) {
        const render_test_event* event = &events[next_event++];
        current_time = event->time;
        flag->value |= event->flags;
        active_thread->frames += event->frames;
        active_thread->cursor_state.x = event->cursor_x;
    }

    if (flag->value & flags) {
        state_locked = 1;
        return 1;
    }

    current_time = deadline;
    return 0;

}

void render_test_msleep(int duration) {
    /* Preserve uninterruptible sleep semantics if the render loop ever uses
     * them, so a regression to fixed sleeps is visible to the latency tests. */
    render_test_timedwait_and_lock(&active_thread->state, 0, duration);
}

void render_test_wait_and_lock(guac_flag* flag, unsigned int flags) {
    CU_ASSERT_EQUAL(state_locked, 0);
    CU_ASSERT_NOT_EQUAL(flag->value & flags, 0);
    state_locked = 1;
}

void render_test_end_frames(guac_display* display, int frames) {
    CU_ASSERT_EQUAL(state_locked, 0);
    flush_count++;
    flushed_frames = frames;
    flushed_cursor_x = display->pending_frame.cursor_x;
    active_thread->state.value |= GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING;
}

/**
 * Runs one frame (or an interrupted frame) through the production render loop.
 * A frame flush requests shutdown to make the otherwise-continuous loop finite.
 */
static void render_frame(unsigned int initial_flags, unsigned int frames,
        int lag, const render_test_event* scheduled_events, int count) {

    guac_client client = { 0 };
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    display->client = &client;
    guac_display_render_thread thread = { 0 };
    thread.display = display;
    thread.state.value = initial_flags;
    thread.frames = frames;

    current_time = 0;
    processing_lag = lag;
    state_locked = 0;
    flush_count = 0;
    flushed_frames = 0;
    flushed_cursor_x = 0;
    active_thread = &thread;
    events = scheduled_events;
    event_count = count;
    next_event = 0;

    guac_display_render_loop(&thread);
    CU_ASSERT_EQUAL(state_locked, 0);
    guac_mem_free(display);
    active_thread = NULL;

}

/** Already completed frames must incur no heuristic batching delay. */
void test_display__ready_frames_skip_batching() {
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 0, NULL, 0);
    CU_ASSERT_EQUAL(current_time, 0);
    CU_ASSERT_EQUAL(flush_count, 1);
    CU_ASSERT_EQUAL(flushed_frames, 1);
}

/** An explicit boundary arriving during batching must wake the renderer. */
void test_display__frame_boundary_interrupts_batching() {
    const render_test_event scheduled[] = {
        { 3, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 42 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 1);
    CU_ASSERT_EQUAL(current_time, 3);
    CU_ASSERT_EQUAL(flush_count, 1);
    CU_ASSERT_EQUAL(flushed_frames, 1);
    CU_ASSERT_EQUAL(flushed_cursor_x, 42);
}

/** Protocols without frame markers must retain small-update batching. */
void test_display__unmarked_frames_retain_batching() {
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, NULL, 0);
    CU_ASSERT_EQUAL(current_time, 10);
    CU_ASSERT_EQUAL(flush_count, 1);
    CU_ASSERT_EQUAL(flushed_frames, 0);
}

/** Frame readiness must never bypass backpressure, including multiple frames. */
void test_display__frame_boundaries_preserve_backpressure() {
    const render_test_event scheduled[] = {
        { 3, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 10 },
        { 6, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 20 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 25, scheduled, 2);
    CU_ASSERT_EQUAL(current_time, 25);
    CU_ASSERT_EQUAL(flush_count, 1);
    CU_ASSERT_EQUAL(flushed_frames, 2);
    CU_ASSERT_EQUAL(flushed_cursor_x, 20);

    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 25, NULL, 0);
    CU_ASSERT_EQUAL(current_time, 25);
    CU_ASSERT_EQUAL(flushed_frames, 1);
}

/** Long lag is bounded, while a short lag is included in the batching period. */
void test_display__client_wait_is_bounded_and_not_added_to_batching() {
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 1000, NULL, 0);
    CU_ASSERT_EQUAL(current_time, GUAC_DISPLAY_MAX_LAG_COMPENSATION);
    CU_ASSERT_EQUAL(flush_count, 1);

    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 4, NULL, 0);
    CU_ASSERT_EQUAL(current_time, 10);
    CU_ASSERT_EQUAL(flush_count, 1);
}

/** Shutdown must interrupt either kind of wait without flushing another frame. */
void test_display__shutdown_interrupts_render_waits() {
    const render_test_event scheduled[] = {
        { 3, GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING, 0, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 1);
    CU_ASSERT_EQUAL(current_time, 3);
    CU_ASSERT_EQUAL(flush_count, 0);

    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 25, scheduled, 1);
    CU_ASSERT_EQUAL(current_time, 3);
    CU_ASSERT_EQUAL(flush_count, 0);
}
