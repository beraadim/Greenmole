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
#define guac_flag_lock render_test_lock
#define guac_flag_set_and_lock render_test_set_and_lock
#define guac_flag_set render_test_set
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
#define guac_display_render_thread_notify_frame_start render_test_notify_start
#define guac_display_render_thread_reset_frame render_test_reset
#define guac_display_render_thread_notify_frame render_test_notify_frame
#define guac_display_render_thread_notify_user_moved_mouse render_test_notify_mouse

#include "../../display-render-thread.c"

#undef guac_timestamp_current
#undef guac_timestamp_msleep
#undef guac_flag_wait_and_lock
#undef guac_flag_timedwait_and_lock
#undef guac_flag_lock
#undef guac_flag_set_and_lock
#undef guac_flag_set
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
#undef guac_display_render_thread_notify_frame_start
#undef guac_display_render_thread_reset_frame
#undef guac_display_render_thread_notify_frame
#undef guac_display_render_thread_notify_user_moved_mouse

/** A change in render state scheduled against the virtual clock. */
typedef struct render_test_event {
    int time;
    unsigned int flags;
    unsigned int frames;
    int cursor_x;
    /* 1=start, 2=reset. flags/frames still model end-only protocols. */
    int action;
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
static unsigned long recorded_source_frames;
static unsigned long recorded_coalesced_frames;
static unsigned long recorded_timeout_closures;

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

void render_test_lock(guac_flag* flag) {
    CU_ASSERT_EQUAL(state_locked, 0);
    state_locked = 1;
}

void render_test_set_and_lock(guac_flag* flag, unsigned int flags) {
    render_test_lock(flag);
    flag->value |= flags;
}

void render_test_set(guac_flag* flag, unsigned int flags) {
    render_test_set_and_lock(flag, flags);
    render_test_unlock(flag);
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
        if (event->action == 1)
            render_test_notify_start(active_thread);
        else if (event->action == 2)
            render_test_reset(active_thread);
        if (event->flags & GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED)
            render_test_notify_modified(active_thread);
        if (event->frames) {
            for (unsigned int i = 0; i < event->frames; i++)
                render_test_notify_frame(active_thread);
        }
        flag->value |= event->flags;
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
    if (!(flag->value & flags))
        render_test_timedwait_and_lock(flag, flags, 1000);
    else
        state_locked = 1;
    CU_ASSERT_NOT_EQUAL(flag->value & flags, 0);
}

void render_test_end_frames(guac_display* display, int frames) {
    CU_ASSERT_EQUAL(state_locked, 0);
    flush_count++;
    flushed_frames = frames;
    flushed_cursor_x = display->pending_frame.cursor_x;
    recorded_source_frames = active_thread->source_frames;
    recorded_coalesced_frames = active_thread->coalesced_frames;
    recorded_timeout_closures = active_thread->closure_reasons[GUAC_DISPLAY_RENDER_SOURCE_TIMEOUT];
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
    thread.quiet_window = 2;
    thread.have_last_modified = !!(initial_flags & GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);

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
    recorded_source_frames = 0;
    recorded_coalesced_frames = 0;
    recorded_timeout_closures = 0;

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

/** A source frame remains coherent even when tile gaps exceed heuristic waits. */
void test_display__source_start_waits_for_matching_end() {
    const render_test_event scheduled[] = {
        { 0, 0, 0, 0, 1 },
        { 18, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 1, 0 },
        { 36, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 2, 0 },
        { 47, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 3, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 4);
    CU_ASSERT_EQUAL(current_time, 47);
    CU_ASSERT_EQUAL(flush_count, 1);
    CU_ASSERT_EQUAL(flushed_frames, 1);
    CU_ASSERT_EQUAL(flushed_cursor_x, 3);
}

/** Lost ends and repeated starts cannot hold output indefinitely. */
void test_display__source_timeout_is_bounded() {
    const render_test_event scheduled[] = {
        { 0, 0, 0, 0, 1 },
        { 40, 0, 0, 1, 1 },
        { 80, 0, 0, 2, 1 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 3);
    CU_ASSERT_EQUAL(current_time, GUAC_DISPLAY_SOURCE_FRAME_TIMEOUT);
    CU_ASSERT_EQUAL(flush_count, 1);
    CU_ASSERT_EQUAL(recorded_timeout_closures, 1);
}

/** A reset releases an incomplete source frame without counting a source end. */
void test_display__source_reset_releases_wait() {
    const render_test_event scheduled[] = {
        { 0, 0, 0, 0, 1 },
        { 23, 0, 0, 1, 2 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 2);
    CU_ASSERT_EQUAL(current_time, 23);
    CU_ASSERT_EQUAL(flushed_frames, 0);
    CU_ASSERT_EQUAL(flush_count, 1);
}

/** A subsequent source start must hold previously completed batches, too. */
void test_display__next_source_frame_blocks_ready_partial_flush() {
    const render_test_event scheduled[] = {
        { 3, 0, 0, 0, 1 },
        { 12, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 2, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY, 1, 8, scheduled, 2);
    CU_ASSERT_EQUAL(current_time, 12);
    CU_ASSERT_EQUAL(flushed_frames, 2);
    CU_ASSERT_EQUAL(recorded_source_frames, 2);
    CU_ASSERT_EQUAL(recorded_coalesced_frames, 1);
}

/** Irregular tile delivery stays together rather than flushing every 10 ms. */
void test_display__jittery_unmarked_tiles_are_grouped() {
    const render_test_event scheduled[] = {
        { 8, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 1, 0 },
        { 16, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 2, 0 },
        { 24, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 3, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 3);
    CU_ASSERT_EQUAL(current_time, GUAC_DISPLAY_UNMARKED_FRAME_BUDGET);
    CU_ASSERT_EQUAL(next_event, 3);
    CU_ASSERT_EQUAL(flushed_cursor_x, 3);
    CU_ASSERT_EQUAL(flush_count, 1);
}

/** Continuous updates cannot indefinitely extend a heuristic frame. */
void test_display__unmarked_continuous_traffic_has_budget() {
    render_test_event scheduled[50];
    for (int i = 0; i < 50; i++)
        scheduled[i] = (render_test_event) {
            i + 1, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, i, 0
        };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 50);
    CU_ASSERT_EQUAL(current_time, GUAC_DISPLAY_UNMARKED_FRAME_BUDGET);
    CU_ASSERT_EQUAL(flush_count, 1);
}

/** Short tile bursts stop after a quiet period, without always using the budget. */
void test_display__quiet_window_follows_recent_tile_gaps() {
    const render_test_event scheduled[] = {
        { 5, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 1, 0 },
        { 9, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 2, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 2);
    CU_ASSERT_EQUAL(current_time, 15);
    CU_ASSERT_EQUAL(flush_count, 1);
}

/** Source-frame waits remain immediately interruptible on shutdown. */
void test_display__shutdown_interrupts_source_wait() {
    const render_test_event scheduled[] = {
        { 0, 0, 0, 0, 1 },
        { 19, GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING, 0, 0, 0 }
    };
    render_frame(GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED, 0, 0, scheduled, 2);
    CU_ASSERT_EQUAL(current_time, 19);
    CU_ASSERT_EQUAL(flush_count, 0);
}

/** Capped percentile buckets are deterministic and distinguish frame jitter. */
void test_display__render_gap_percentiles() {
    guac_display_render_thread thread = { 0 };
    thread.gap_count = 20;
    thread.gap_histogram[10] = 10;
    thread.gap_histogram[16] = 8;
    thread.gap_histogram[40] = 1;
    thread.gap_histogram[100] = 1;
    CU_ASSERT_EQUAL(guac_display_render_gap_percentile(&thread, 50), 10);
    CU_ASSERT_EQUAL(guac_display_render_gap_percentile(&thread, 95), 40);
    CU_ASSERT_EQUAL(guac_display_render_gap_percentile(&thread, 100), 100);
}

/** Cursor activity must not be mistaken for a jittery graphical tile stream. */
void test_display__cursor_does_not_train_graphical_grouping() {
    guac_display_render_thread thread = { 0 };
    thread.quiet_window = 2;
    state_locked = 0;
    current_time = 0;
    render_test_notify_modified(&thread);
    current_time = 8;
    render_test_notify_modified(&thread);
    CU_ASSERT_EQUAL(thread.quiet_window, GUAC_DISPLAY_UNMARKED_QUIET_LIMIT);
    current_time = 9;
    render_test_notify_mouse(&thread, NULL, 10, 20, 0);
    CU_ASSERT_EQUAL(thread.last_modified, 8);
    CU_ASSERT_EQUAL(thread.quiet_window, GUAC_DISPLAY_UNMARKED_QUIET_LIMIT);
    current_time = 30;
    render_test_notify_modified(&thread);
    CU_ASSERT_EQUAL(thread.quiet_window, 2);
    CU_ASSERT_EQUAL(state_locked, 0);
}
