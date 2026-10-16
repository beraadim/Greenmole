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
#include "display-workers.h"
#include "guacamole/client.h"
#include "guacamole/fifo.h"

#include <inttypes.h>
#include <pthread.h>
#include <stdlib.h>

/* Partial UI batches can use fewer persistent workers without constraining
 * large desktop changes. Production-path measurements select the ceiling;
 * isolated codec-barrier measurements do not predict frame latency. These
 * bounds change concurrency only, not quality, frame grouping or FIFO data. */
#define GUAC_DISPLAY_LARGE_BATCH_PIXELS (4U * 1024U * 1024U)

static int select_active_workers(int pool_size, size_t image_count,
        uint64_t image_pixels, uint64_t desktop_pixels, int medium_limit) {

    int limit = pool_size > 0 ? pool_size : 1;
    if (image_pixels < GUAC_DISPLAY_LARGE_BATCH_PIXELS
            && desktop_pixels > 0 && image_pixels * 2 < desktop_pixels
            && limit > medium_limit)
        limit = medium_limit;
    if (image_count < (size_t) limit)
        limit = image_count > 0 ? (int) image_count : 1;
    return limit;

}

int guac_display_select_active_workers(int pool_size, size_t image_count,
        uint64_t image_pixels, uint64_t desktop_pixels) {
    return select_active_workers(pool_size, image_count, image_pixels,
            desktop_pixels, GUAC_DISPLAY_PARTIAL_BATCH_WORKERS);
}

void guac_display_configure_worker_frame(guac_display* display,
        const guac_display_plan* plan) {

    /* stop() invalidates under this same FIFO lock before joining/resetting
     * the pool. A producer finishing teardown must never inspect that count. */
    if (!guac_fifo_is_valid(&display->ops))
        return;

    /* Only opt-in diagnostics read a high-resolution clock. This timestamp
     * precedes publication and any inline copy/fill instructions in the plan. */
    if (display->diagnostics_enabled) {
        display->diagnostics_batch_started_us = guac_display_diagnostics_now();
        if (display->diagnostics_batch_started_us == 0)
            guac_display_diagnostics_fail(display);
    }

    size_t images = 0;
    uint64_t pixels = 0;
    for (size_t i = 0; i < plan->length; i++) {
        const guac_display_plan_operation* op = &plan->ops[i];
        if (op->type == GUAC_DISPLAY_PLAN_OPERATION_IMG) {
            images++;
            pixels += (uint64_t) guac_rect_width(&op->dest)
                * (uint64_t) guac_rect_height(&op->dest);
        }
    }

    /* A new frame is enqueued only after all prior workers have finished.
     * The limit is immutable while any worker is active, including at stop. */
    uint64_t desktop_pixels = display->default_layer == NULL ? 0
        : (uint64_t) display->default_layer->last_frame.width
            * (uint64_t) display->default_layer->last_frame.height;
    display->worker_active_limit = display->worker_workload_aware
        ? select_active_workers(display->worker_thread_count,
                images, pixels, desktop_pixels, display->worker_medium_limit > 0
                    ? display->worker_medium_limit : GUAC_DISPLAY_PARTIAL_BATCH_WORKERS)
        : display->worker_thread_count;

    guac_client_log(display->client, GUAC_LOG_TRACE,
            "Encoder batch: active-limit=%i pool=%i images=%zu pixels=%" PRIu64 ".",
            display->worker_active_limit, display->worker_thread_count,
            images, pixels);

}

void guac_display_set_worker_policy(guac_display* display, int workload_aware) {
    if (workload_aware < 0 || workload_aware > GUAC_DISPLAY_MAX_WORKER_THREADS)
        return;
    guac_fifo_lock(&display->ops);
    display->worker_workload_aware = workload_aware != 0;
    display->worker_medium_limit = workload_aware > 1 ? workload_aware
        : GUAC_DISPLAY_PARTIAL_BATCH_WORKERS;
    guac_fifo_unlock(&display->ops);
}

int guac_display_worker_dequeue_and_lock(guac_display* display,
        guac_display_plan_operation* operation) {

    guac_fifo* fifo = &display->ops;
    guac_fifo_lock(fifo);
    while (guac_fifo_is_valid(fifo)) {

        if ((fifo->state.value & GUAC_FIFO_STATE_NONEMPTY)
                && display->active_workers < (unsigned int) display->worker_active_limit) {
            /* NONEMPTY was checked while holding the FIFO lock. The standard
             * dequeue therefore cannot wait. Release its recursive acquisition
             * while retaining our original lock for active-worker accounting. */
            int dequeued = guac_fifo_dequeue_and_lock(fifo, operation);
            guac_fifo_unlock(fifo);
            return dequeued;
        }

        /* Exactly one acquisition is held here: waiting on a recursively held
         * mutex would otherwise prevent producers/completing workers running.
         * Enqueue and invalidation broadcast this existing FIFO condition;
         * worker completion signals one waiter when capacity becomes free. */
        if (pthread_cond_wait(&fifo->state.value_changed,
                    &fifo->state.value_mutex))
            abort();
    }

    guac_fifo_unlock(fifo);
    return 0;

}
