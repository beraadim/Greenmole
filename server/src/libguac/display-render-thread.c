/*
 * Modified for Greenmole by its maintainers.
 *
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

#include "display-priv.h"
#include "guacamole/client.h"
#include "guacamole/display.h"
#include "guacamole/flag.h"
#include "guacamole/mem.h"
#include "guacamole/proctitle.h"
#include "guacamole/timestamp.h"

/** An isolated unmarked update retains the existing 10 ms batching delay. */
#define GUAC_DISPLAY_RENDER_THREAD_MIN_FRAME_DURATION 10

/** Emit aggregate diagnostics no more frequently than once every 10 seconds. */
#define GUAC_DISPLAY_RENDER_DIAGNOSTICS_INTERVAL 10000

/**
 * Returns an approximate percentile of inter-batch gaps in milliseconds. The
 * final bucket includes all gaps of 100 ms or greater, keeping storage bounded.
 */
static unsigned int guac_display_render_gap_percentile(
        guac_display_render_thread* thread, unsigned int percentile) {
    unsigned long threshold = (thread->gap_count * percentile + 99) / 100;
    unsigned long cumulative = 0;
    for (unsigned int i = 0; i < GUAC_DISPLAY_RENDER_GAP_BUCKETS; i++) {
        cumulative += thread->gap_histogram[i];
        if (cumulative >= threshold)
            return i;
    }
    return 0;
}

/** Records scheduler decisions, without retaining frame contents or identifiers. */
static void guac_display_render_record_batch(guac_display_render_thread* thread,
        guac_timestamp now, int frames, guac_display_render_reason reason) {
    thread->batches++;
    thread->source_frames += frames;
    if (frames > 1)
        thread->coalesced_frames += frames - 1;
    thread->closure_reasons[reason]++;

    if (thread->have_last_batch) {
        guac_timestamp gap = now - thread->last_batch;
        if (gap < 0)
            gap = 0;
        if (gap >= GUAC_DISPLAY_RENDER_GAP_BUCKETS)
            gap = GUAC_DISPLAY_RENDER_GAP_BUCKETS - 1;
        thread->gap_histogram[gap]++;
        thread->gap_count++;
    }
    thread->have_last_batch = 1;
    thread->last_batch = now;

    if (now - thread->last_diagnostics >= GUAC_DISPLAY_RENDER_DIAGNOSTICS_INTERVAL) {
        guac_client_log(thread->display->client, GUAC_LOG_TRACE,
                "Render batches=%lu source-frames=%lu coalesced=%lu "
                "closures[explicit=%lu quiet=%lu budget=%lu missing-end=%lu] "
                "batch-gap-ms[p50=%u p95=%u cap=100]",
                thread->batches, thread->source_frames, thread->coalesced_frames,
                thread->closure_reasons[GUAC_DISPLAY_RENDER_EXPLICIT],
                thread->closure_reasons[GUAC_DISPLAY_RENDER_QUIET],
                thread->closure_reasons[GUAC_DISPLAY_RENDER_BUDGET],
                thread->closure_reasons[GUAC_DISPLAY_RENDER_SOURCE_TIMEOUT],
                guac_display_render_gap_percentile(thread, 50),
                guac_display_render_gap_percentile(thread, 95));
        thread->last_diagnostics = now;
    }
}

/**
 * Render complete source frames whenever boundaries are available. Unmarked
 * streams retain a 10 ms minimum but extend batching through short measured
 * gaps, with a strict 32 ms budget so continuous traffic cannot starve output.
 * Cursor input does not train or prolong the graphical quiet-window estimate.
 */
static void* guac_display_render_loop(void* data) {

    guac_thread_name_set("display-render");

    guac_display_render_thread* render_thread = data;
    guac_display* display = render_thread->display;
    guac_client* client = display->client;

    for (;;) {
        guac_flag_wait_and_lock(&render_thread->state,
                  GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING
                | GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY
                | GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);

        if (render_thread->state.value & GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING) {
            guac_flag_unlock(&render_thread->state);
            return NULL;
        }

        guac_timestamp frame_start = guac_timestamp_current();
        guac_flag_unlock(&render_thread->state);

        /* Ready source frames must still obey browser backpressure. Time
         * spent waiting here also counts toward the heuristic batching budget.
         * Only shutdown interrupts this bounded wait. */
        int elapsed = frame_start - client->last_sent_timestamp;
        int required_wait = guac_client_get_processing_lag(client) - elapsed;
        if (required_wait > GUAC_DISPLAY_MAX_LAG_COMPENSATION)
            required_wait = GUAC_DISPLAY_MAX_LAG_COMPENSATION;
        if (required_wait > 0) {
            if (guac_flag_timedwait_and_lock(&render_thread->state,
                        GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING, required_wait)) {
                guac_flag_unlock(&render_thread->state);
                return NULL;
            }
        }

        guac_flag_lock(&render_thread->state);
        guac_display_render_reason reason;
        for (;;) {
            if (render_thread->state.value & GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING) {
                guac_flag_unlock(&render_thread->state);
                return NULL;
            }

            guac_timestamp now = guac_timestamp_current();
            guac_timestamp deadline;
            if (render_thread->source_frame_open) {
                deadline = render_thread->source_frame_start
                    + GUAC_DISPLAY_SOURCE_FRAME_TIMEOUT;
                if (now >= deadline) {
                    render_thread->source_frame_open = 0;
                    reason = GUAC_DISPLAY_RENDER_SOURCE_TIMEOUT;
                    break;
                }
            }
            else {
                if (render_thread->frames) {
                    reason = GUAC_DISPLAY_RENDER_EXPLICIT;
                    break;
                }

                guac_timestamp budget = frame_start + GUAC_DISPLAY_UNMARKED_FRAME_BUDGET;
                if (now >= budget) {
                    reason = GUAC_DISPLAY_RENDER_BUDGET;
                    break;
                }

                deadline = frame_start + GUAC_DISPLAY_RENDER_THREAD_MIN_FRAME_DURATION;
                if (render_thread->have_last_modified) {
                    guac_timestamp quiet_end = render_thread->last_modified
                        + render_thread->quiet_window;
                    if (quiet_end > deadline)
                        deadline = quiet_end;
                }
                if (now >= deadline) {
                    reason = GUAC_DISPLAY_RENDER_QUIET;
                    break;
                }
                if (deadline > budget)
                    deadline = budget;
            }

            /* Clear consumed wakeups before sleeping. Start/end/reset and
             * modifications all wake the loop to recompute its deadline.
             * FRAME_READY alone is insufficient while a later frame is open. */
            guac_flag_clear(&render_thread->state,
                      GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY
                    | GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);
            guac_flag_unlock(&render_thread->state);
            if (!guac_flag_timedwait_and_lock(&render_thread->state,
                          GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING
                        | GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY
                        | GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED,
                        deadline - now))
                guac_flag_lock(&render_thread->state);
        }

        guac_display_render_thread_cursor_state cursor = render_thread->cursor_state;
        int rendered_frames = render_thread->frames;
        render_thread->frames = 0;
        guac_flag_clear(&render_thread->state,
                  GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY
                | GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);
        guac_flag_unlock(&render_thread->state);

        guac_display_render_record_batch(render_thread, guac_timestamp_current(),
                rendered_frames, reason);

        /* Never hold render state while acquiring pending_frame.lock. Source
         * marker callbacks may already hold the reentrant pending-frame write
         * lock. The display-level source gate also protects against a new
         * start racing this point and against independent worker flushes. */
        guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
        display->pending_frame.cursor_user = cursor.user;
        display->pending_frame.cursor_x = cursor.x;
        display->pending_frame.cursor_y = cursor.y;
        display->pending_frame.cursor_mask = cursor.mask;
        guac_rwlock_release_lock(&display->pending_frame.lock);
        guac_display_end_multiple_frames(display, rendered_frames);
    }

}

guac_display_render_thread* guac_display_render_thread_create(guac_display* display) {

    guac_display_render_thread* render_thread = guac_mem_zalloc(sizeof(guac_display_render_thread));

    guac_flag_init(&render_thread->state);
    render_thread->display = display;
    render_thread->frames = 0;
    render_thread->quiet_window = 2;
    render_thread->last_diagnostics = guac_timestamp_current();

    /* Start render thread (this will immediately begin blocking until frame
     * modification or readiness is signalled) */
    pthread_create(&render_thread->thread, NULL, guac_display_render_loop, render_thread);

    return render_thread;

}

void guac_display_render_thread_notify_modified(guac_display_render_thread* render_thread) {
    guac_flag_set_and_lock(&render_thread->state, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);
    guac_timestamp now = guac_timestamp_current();
    if (render_thread->have_last_modified) {
        guac_timestamp gap = now - render_thread->last_modified;
        if (gap > 0) {
            /* Nearby updates are likely pieces of one burst. A 50% margin
             * absorbs moderate jitter; large gaps are separate interactions. */
            render_thread->quiet_window = gap <= GUAC_DISPLAY_UNMARKED_QUIET_LIMIT
                ? (gap * 3 + 1) / 2 : 2;
            if (render_thread->quiet_window > GUAC_DISPLAY_UNMARKED_QUIET_LIMIT)
                render_thread->quiet_window = GUAC_DISPLAY_UNMARKED_QUIET_LIMIT;
        }
    }
    render_thread->last_modified = now;
    render_thread->have_last_modified = 1;
    guac_flag_unlock(&render_thread->state);
}

void guac_display_render_thread_notify_frame_start(guac_display_render_thread* render_thread) {
    guac_display* display = render_thread->display;
    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
    guac_timestamp now = guac_timestamp_current();
    if (!display->source_frame_open) {
        display->source_frame_open = 1;
        display->source_frame_start = now;
    }
    guac_flag_set_and_lock(&render_thread->state, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);
    render_thread->source_frame_open = 1;
    render_thread->source_frame_start = display->source_frame_start;
    guac_flag_unlock(&render_thread->state);
    guac_rwlock_release_lock(&display->pending_frame.lock);
}

void guac_display_render_thread_notify_frame(guac_display_render_thread* render_thread) {
    guac_display* display = render_thread->display;
    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
    display->source_frame_open = 0;
    guac_flag_set_and_lock(&render_thread->state, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_READY);
    render_thread->source_frame_open = 0;
    render_thread->frames++;
    guac_flag_unlock(&render_thread->state);
    guac_rwlock_release_lock(&display->pending_frame.lock);
}

void guac_display_render_thread_reset_frame(guac_display_render_thread* render_thread) {
    guac_display* display = render_thread->display;
    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
    display->source_frame_open = 0;
    guac_flag_set_and_lock(&render_thread->state, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);
    render_thread->source_frame_open = 0;
    guac_flag_unlock(&render_thread->state);
    guac_rwlock_release_lock(&display->pending_frame.lock);
}

void guac_display_render_thread_notify_user_moved_mouse(guac_display_render_thread* render_thread,
        guac_user* user, int x, int y, int mask) {

    guac_flag_set_and_lock(&render_thread->state, GUAC_DISPLAY_RENDER_THREAD_STATE_FRAME_MODIFIED);
    render_thread->cursor_state.user = user;
    render_thread->cursor_state.x = x;
    render_thread->cursor_state.y = y;
    render_thread->cursor_state.mask = mask;
    guac_flag_unlock(&render_thread->state);

}

void guac_display_render_thread_destroy(guac_display_render_thread* render_thread) {

    /* Clean up render thread after signalling it to stop */
    guac_flag_set(&render_thread->state, GUAC_DISPLAY_RENDER_THREAD_STATE_STOPPING);
    pthread_join(render_thread->thread, NULL);

    /* A reconnect may reuse this display with a new render thread. Do not
     * leave the previous source's unmatched marker holding its worker flushes. */
    guac_rwlock_acquire_write_lock(&render_thread->display->pending_frame.lock);
    render_thread->display->source_frame_open = 0;
    guac_rwlock_release_lock(&render_thread->display->pending_frame.lock);

    /* Free remaining resources */
    guac_flag_destroy(&render_thread->state);
    guac_mem_free(render_thread);

}

