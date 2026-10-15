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

#include "display-plan.h"
#include "display-priv.h"
#include "guacamole/assert.h"
#include "guacamole/client.h"
#include "guacamole/display.h"
#include "guacamole/fifo.h"
#include "guacamole/flag.h"
#include "guacamole/mem.h"
#include "guacamole/protocol.h"
#include "guacamole/rect.h"
#include "guacamole/rwlock.h"
#include "guacamole/user.h"

#include <string.h>

/**
 * Begins a section related to an optimization phase that should be tracked for
 * performance at the "trace" log level.
 */
#define GUAC_DISPLAY_PLAN_BEGIN_PHASE()                                       \
    do {                                                                      \
        guac_timestamp phase_start = guac_timestamp_current();

/**
 * Ends a section related to an optimization phase that should be tracked for
 * performance at the "trace" log level.
 *
 * @param display
 *     The guac_display related to the optimizations being performed.
 *
 * @param phase
 *     A human-readable name for the optimization phase being tracked.
 *
 * @param n
 *     The ordinal number of this phase relative to other phases, where the
 *     first phase is phase 1.
 *
 * @param total
 *     The total number of optimization phases.
 */
#define GUAC_DISPLAY_PLAN_END_PHASE(display, phase, n, total)                 \
        guac_timestamp phase_end = guac_timestamp_current();                  \
        guac_client_log(display->client, GUAC_LOG_TRACE, "Render planning "   \
                "phase %i/%i (%s): %ims", n, total, phase,                    \
                (int) (phase_end - phase_start));                             \
    } while (0)

void guac_display_end_frame(guac_display* display) {
    guac_display_end_multiple_frames(display, 0);
}

/**
 * Callback for guac_client_foreach_user() which sends the current cursor
 * position and button state to any given user except the user that moved the
 * cursor last.
 *
 * @param data
 *     A pointer to the guac_display whose cursor state should be broadcast to
 *     all users except the user that moved the cursor last.
 *
 * @return
 *     Always NULL.
 */
static void* LFR_guac_display_broadcast_cursor_state(guac_user* user, void* data) {

    guac_display* display = (guac_display*) data;

    /* Send cursor state only if the user is not moving the cursor */
    if (user != display->last_frame.cursor_user) {
        guac_protocol_send_mouse(user->socket,
                display->last_frame.cursor_x, display->last_frame.cursor_y,
                display->last_frame.cursor_mask, display->last_frame.timestamp);
        guac_socket_flush(user->socket);
    }

    return NULL;

}

/**
 * Persists a layer's pending pixels in its last-frame buffer. Stable buffers
 * need only the refined dirty rectangle copied; copying the entire desktop for
 * each small update needlessly holds both frame locks and consumes bandwidth
 * within memory. Buffer replacements and geometry changes still require a full
 * copy so that pixels which become visible later are initialized correctly.
 *
 * @param layer
 *     The layer whose pending pixels should be committed. Both frame locks
 *     must be held for writing.
 *
 * @return
 *     The number of bytes copied into the last-frame buffer.
 */
static size_t PFW_LFW_guac_display_layer_commit_buffer(guac_display_layer* layer) {

    guac_display_layer_state* pending = &layer->pending_frame;
    guac_display_layer_state* last = &layer->last_frame;

    /* External buffers may be detached before their owner frees them. Keep
     * the existing snapshot, and force a full copy if a buffer is reattached. */
    if (pending->buffer == NULL) {
        GUAC_ASSERT(pending->buffer_is_external);
        last->dirty = (guac_rect) { 0 };
        layer->pending_frame_buffer_replaced = 1;
        return 0;
    }

    GUAC_ASSERT(pending->width >= 0 && pending->height >= 0);
    GUAC_ASSERT(pending->buffer_width >= 0 && pending->buffer_height >= 0);
    GUAC_ASSERT(pending->buffer_stride >= guac_mem_ckd_mul_or_die(
                pending->buffer_width, GUAC_DISPLAY_LAYER_RAW_BPP));

    /* Constrain all byte offsets before forming any buffer pointers. The
     * visible layer can be smaller than its backing allocation, and external
     * buffers may include row padding. Neither should extend a dirty copy. */
    guac_rect bounds = {
        .left = 0,
        .top = 0,
        .right = pending->width,
        .bottom = pending->height
    };
    if (bounds.right > pending->buffer_width)
        bounds.right = pending->buffer_width;
    if (bounds.bottom > pending->buffer_height)
        bounds.bottom = pending->buffer_height;

    guac_rect dirty = pending->dirty;
    guac_rect_constrain(&dirty, &bounds);
    if (guac_rect_is_empty(&dirty))
        dirty = (guac_rect) { 0 };

    size_t buffer_size = guac_mem_ckd_mul_or_die(pending->buffer_height,
            pending->buffer_stride);
    size_t copied = 0;

    /* Resize the snapshot before considering a partial copy. This must also
     * work when the pending buffer was supplied by an external owner. */
    if (last->buffer == NULL
            || last->buffer_stride != pending->buffer_stride
            || last->buffer_width != pending->buffer_width
            || last->buffer_height != pending->buffer_height) {

        guac_mem_free(last->buffer);
        last->buffer = guac_mem_zalloc(buffer_size);
        GUAC_ASSERT(buffer_size == 0 || last->buffer != NULL);
        if (buffer_size != 0)
            memcpy(last->buffer, pending->buffer, buffer_size);

        last->buffer_stride = pending->buffer_stride;
        last->buffer_width = pending->buffer_width;
        last->buffer_height = pending->buffer_height;
        copied = buffer_size;

    }

    /* A new source buffer or visible geometry can expose pixels outside the
     * current dirty rectangle. Preserve a complete snapshot in those cases. */
    else if (layer->pending_frame_buffer_replaced
            || pending->width != last->width
            || pending->height != last->height) {
        copied = buffer_size;
        if (copied != 0)
            memcpy(last->buffer, pending->buffer, copied);
    }

    else if (!guac_rect_is_empty(&dirty)) {

        size_t row_length = guac_mem_ckd_mul_or_die(guac_rect_width(&dirty),
                GUAC_DISPLAY_LAYER_RAW_BPP);
        size_t offset = guac_mem_ckd_add_or_die(
                guac_mem_ckd_mul_or_die(dirty.top, pending->buffer_stride),
                guac_mem_ckd_mul_or_die(dirty.left, GUAC_DISPLAY_LAYER_RAW_BPP));
        const unsigned char* source = pending->buffer + offset;
        unsigned char* destination = last->buffer + offset;
        int rows = guac_rect_height(&dirty);
        copied = guac_mem_ckd_mul_or_die(rows, row_length);

        while (rows > 0) {
            memcpy(destination, source, row_length);
            /* Advancing a pointer beyond the last row could itself overflow
             * the allocation when the dirty rectangle has a nonzero X offset. */
            if (--rows > 0) {
                source += pending->buffer_stride;
                destination += last->buffer_stride;
            }
        }

    }

    last->dirty = dirty;
    pending->dirty = (guac_rect) { 0 };
    layer->pending_frame_buffer_replaced = 0;
    return copied;

}

/**
 * Finalizes the current pending frame, storing that state as the copy of the
 * last frame. All layer properties that have changed since the last frame will
 * be sent out to connected clients.
 *
 * @param display
 *     The display whose pending frame should be finalized and persisted as the
 *     last frame.
 *
 * @return
 *     Non-zero if any layers within the pending frame had any changes
 *     whatsoever that needed to be sent as part of the frame, zero otherwise.
 */
static int PFW_LFW_guac_display_frame_complete(guac_display* display) {

    guac_client* client = display->client;
    int retval = 0;
    size_t copied_bytes = 0;

    display->last_frame.layers = display->pending_frame.layers;
    for (guac_display_layer* current = display->pending_frame.layers;
            current != NULL; current = current->pending_frame.next) {

        /* Duplicate layers from pending frame to last frame */
        current->last_frame.prev = current->pending_frame.prev;
        current->last_frame.next = current->pending_frame.next;

        /* Detached external buffers retain no graphical or property updates. */
        if (current->pending_frame.buffer == NULL) {
            PFW_LFW_guac_display_layer_commit_buffer(current);
            continue;
        }

        size_t copied = PFW_LFW_guac_display_layer_commit_buffer(current);
        copied_bytes = guac_mem_ckd_add_or_die(copied_bytes, copied);
        if (copied != 0)
            retval = 1;

        /* Commit any change in layer size */
        if (current->pending_frame.width != current->last_frame.width
                || current->pending_frame.height != current->last_frame.height) {

            guac_protocol_send_size(client->socket, current->layer,
                    current->pending_frame.width, current->pending_frame.height);

            current->last_frame.width = current->pending_frame.width;
            current->last_frame.height = current->pending_frame.height;

            retval = 1;

        }

        /* Commit any change in layer opacity */
        if (current->pending_frame.opacity != current->last_frame.opacity) {

            guac_protocol_send_shade(client->socket, current->layer,
                    current->pending_frame.opacity);

            current->last_frame.opacity = current->pending_frame.opacity;

            retval = 1;

        }

        /* Commit any change in layer location/hierarchy */
        if (current->pending_frame.x != current->last_frame.x
                || current->pending_frame.y != current->last_frame.y
                || current->pending_frame.z != current->last_frame.z
                || current->pending_frame.parent != current->last_frame.parent) {

            guac_protocol_send_move(client->socket, current->layer,
                    current->pending_frame.parent,
                    current->pending_frame.x,
                    current->pending_frame.y,
                    current->pending_frame.z);

            current->last_frame.x = current->pending_frame.x;
            current->last_frame.y = current->pending_frame.y;
            current->last_frame.z = current->pending_frame.z;
            current->last_frame.parent = current->pending_frame.parent;

            retval = 1;

        }

        /* Commit any change in layer multitouch support */
        if (current->pending_frame.touches != current->last_frame.touches) {
            guac_protocol_send_set_int(client->socket, current->layer,
                    GUAC_PROTOCOL_LAYER_PARAMETER_MULTI_TOUCH,
                    current->pending_frame.touches);
            current->last_frame.touches = current->pending_frame.touches;
        }

        /* Commit any hinting regarding scroll/copy optimization (NOTE: While
         * this value is copied for consistency, it will already have taken
         * effect in the context of the pending frame due to the scroll/copy
         * optimization pass having occurred prior to the call to this
         * function) */
        current->last_frame.search_for_copies = current->pending_frame.search_for_copies;
        current->pending_frame.search_for_copies = 0;

        /* Commit any change in lossless setting (no need to synchronize this
         * to the client - it affects only how last_frame is interpreted) */
        current->last_frame.lossless = current->pending_frame.lossless;

    }

    guac_client_log(client, GUAC_LOG_TRACE,
            "Frame snapshot: %zu bytes copied.", copied_bytes);

    display->last_frame.timestamp = display->pending_frame.timestamp;
    display->last_frame.frames = display->pending_frame.frames;

    display->pending_frame.frames = 0;
    display->pending_frame_dirty_excluding_mouse = 0;

    /* Commit cursor hotspot */
    display->last_frame.cursor_hotspot_x = display->pending_frame.cursor_hotspot_x;
    display->last_frame.cursor_hotspot_y = display->pending_frame.cursor_hotspot_y;

    /* Commit mouse cursor location and notify all other users of change in
     * cursor state */
    if (display->pending_frame.cursor_x != display->last_frame.cursor_x
            || display->pending_frame.cursor_y != display->last_frame.cursor_y
            || display->pending_frame.cursor_mask != display->last_frame.cursor_mask) {

        display->last_frame.cursor_user = display->pending_frame.cursor_user;
        display->last_frame.cursor_x = display->pending_frame.cursor_x;
        display->last_frame.cursor_y = display->pending_frame.cursor_y;
        display->last_frame.cursor_mask = display->pending_frame.cursor_mask;
        guac_client_foreach_user(client, LFR_guac_display_broadcast_cursor_state, display);

        /* NOTE: We DO NOT set retval here, as flushing a frame due purely to
         * mouse position changes can cause slowdowns apparently from the sheer
         * quantity of frames */

    }

    return retval;

}

void guac_display_end_mouse_frame(guac_display* display) {

    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);

    if (!display->pending_frame_dirty_excluding_mouse)
        guac_display_end_multiple_frames(display, 0);

    guac_rwlock_release_lock(&display->pending_frame.lock);

}

void guac_display_end_multiple_frames(guac_display* display, int frames) {

    guac_display_plan* plan = NULL;
    guac_display_layer* removed_layers = NULL;

    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
    display->pending_frame.frames += frames;

    /* The render scheduler is not the only caller: workers also retry deferred
     * flushes after finishing the previous frame. Keep this gate under the
     * snapshot lock so neither path can expose an incomplete source frame.
     * A lost end marker must not hold output indefinitely. */
    if (display->source_frame_open) {
        if (guac_timestamp_current() - display->source_frame_start
                < GUAC_DISPLAY_SOURCE_FRAME_TIMEOUT)
            goto finished_with_pending_frame_lock;
        display->source_frame_open = 0;
    }

    /* Defer rendering of further frames until after any in-progress frame has
     * finished. Graphical changes will meanwhile continue being accumulated in
     * the pending frame. */

    guac_fifo_lock(&display->ops);
    int defer_frame = display->frame_deferred =
        (display->ops.state.value & GUAC_FIFO_STATE_NONEMPTY) || display->active_workers;
    guac_fifo_unlock(&display->ops);

    if (defer_frame)
        goto finished_with_pending_frame_lock;

    guac_rwlock_acquire_write_lock(&display->last_frame.lock);

    /* PASS 0: Create naive plan, identify minimal dirty rects by comparing the
     * changes between the pending and last frames.
     *
     * This plan will contain operations covering only the minimal parts of the
     * display that have changed, but is naive in the sense that it only
     * produces draw operations covering 64x64 cells. There is room for
     * optimization of those operations, which will be performed by further
     * passes. */
    GUAC_DISPLAY_PLAN_BEGIN_PHASE();
    plan = PFW_LFR_guac_display_plan_create(display);
    GUAC_DISPLAY_PLAN_END_PHASE(display, "draft", 1, 5);

    if (plan != NULL) {

        display->pending_frame.timestamp = plan->frame_end;

        /* PASS 1: Identify draw operations that only apply a single color, and
         * replace those operations with simple rectangle draws. */
        GUAC_DISPLAY_PLAN_BEGIN_PHASE();
        PFR_guac_display_plan_rewrite_as_rects(plan);
        GUAC_DISPLAY_PLAN_END_PHASE(display, "rects", 2, 5);

        /* PASS 2 (and 3): Index all modified cells by their graphical contents and
         * search the previous frame for occurrences of the same content. Where any
         * draws could instead be represented as copies from the previous frame, do
         * so instead of sending new image data. */
        GUAC_DISPLAY_PLAN_BEGIN_PHASE();
        PFR_guac_display_plan_index_dirty_cells(plan);
        PFR_LFR_guac_display_plan_rewrite_as_copies(plan);
        GUAC_DISPLAY_PLAN_END_PHASE(display, "search", 3, 5);

        /* PASS 4 (and 5): Combine adjacent updates in horizontal and vertical
         * directions where doing so would be more efficient. The goal of these
         * passes is to ensure that graphics can be encoded and decoded
         * efficiently, without defeating the parralelism provided by providing the
         * worker threads with many smaller operations. */
        GUAC_DISPLAY_PLAN_BEGIN_PHASE();
        PFW_guac_display_plan_combine_horizontally(plan);
        PFW_guac_display_plan_combine_vertically(plan);
        GUAC_DISPLAY_PLAN_END_PHASE(display, "combine", 4, 5);

    }

    /*
     * With all optimizations now performed, finalize the pending frame. This
     * sets the worker threads in motion and frees up the pending frame
     * surfaces for writing. Drawing to the next pending frame can now occur
     * without disturbing the encoding performed by the worker threads.
     */

    int frame_nonempty;

    GUAC_DISPLAY_PLAN_BEGIN_PHASE();
    frame_nonempty = PFW_LFW_guac_display_frame_complete(display);
    GUAC_DISPLAY_PLAN_END_PHASE(display, "commit", 5, 5);

    guac_rwlock_release_lock(&display->last_frame.lock);

    /* The last frame layer list has now been rebuilt from the pending frame
     * layer list, so any layers removed since the previous flush are no longer
     * part of either frame. Detach them for destruction below.
     *
     * IMPORTANT: These layers MUST NOT be freed until after the frame is fully
     * flushed. The display plan may reference a removed layer's buffer as the
     * source of a copy operation, and that plan has not yet been applied. */
    removed_layers = display->pending_frame_removed_layers;
    display->pending_frame_removed_layers = NULL;

    /* Awaken worker threads to perform the rest of the tasks required for the
     * frame (if any such tasks remain) */
    if (plan != NULL) {
        guac_display_plan_apply(plan);
        guac_display_plan_free(plan);
    }

    /* Not all frames are graphical, and not all frames result in operations
     * reaching the worker threads. If we end up with a frame containing
     * nothing but layer property changes or nothing but non-image updates,
     * then we must still send at least one operation to awaken the workers,
     * flush any layer changes, and mark the end of the frame with a "sync",
     * even though there is no display plan to optimize.  */
    if (frame_nonempty) {
        guac_display_plan_operation end_frame_op = {
            .type = GUAC_DISPLAY_PLAN_OPERATION_NOP
        };
        guac_fifo_enqueue(&display->ops, &end_frame_op);
    }

finished_with_pending_frame_lock:
    guac_rwlock_release_lock(&display->pending_frame.lock);

    /* Free any layers detached above. NOTE: This is intentionally done outside
     * the pending frame lock to avoid contending with drawing operations. */
    guac_display_free_removed_layers(display, removed_layers);

}
