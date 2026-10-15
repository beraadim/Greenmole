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
#include "../../display-workers.h"
#include "guacamole/client.h"
#include "guacamole/fifo.h"
#include "guacamole/flag.h"
#include "guacamole/mem.h"

#include <pthread.h>
#include <stdint.h>
#include <string.h>

/** Limits never exceed the real pool or available image operations. */
void test_display__active_worker_selection_is_bounded() {
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 0, 0, 8294400), 1);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 4, 57600, 8294400), 4);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 48, 2764800, 8294400), 12);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 32, 8294400, 8294400), 22);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 1, UINT64_MAX, 8294400), 1);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(2, 48, 2764800, 8294400), 2);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(1, 48, UINT64_MAX, 8294400), 1);
    /* Full-window transitions keep the pool even on non-4K desktops. */
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 32, 3344640, 3344640), 22);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 32, 1812480, 1812480), 22);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 32, 1812480, 0), 22);
    CU_ASSERT_EQUAL(guac_display_select_active_workers(22, 64, UINT64_MAX, UINT64_MAX), 22);
}

/** The planner counts only real image operations, not cheap copies or fills. */
void test_display__worker_frame_policy_counts_only_images() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    guac_client client = { 0 };
    display->client = &client;
    display->worker_thread_count = 22;
    display->worker_workload_aware = 1;
    guac_display_plan_operation ops[4] = {
        { .type = GUAC_DISPLAY_PLAN_OPERATION_IMG, .dest = { 0, 0, 512, 512 } },
        { .type = GUAC_DISPLAY_PLAN_OPERATION_IMG, .dest = { 512, 0, 1024, 512 } },
        { .type = GUAC_DISPLAY_PLAN_OPERATION_COPY, .dest = { 0, 0, 8192, 8192 } },
        { .type = GUAC_DISPLAY_PLAN_OPERATION_RECT, .dest = { 0, 0, 8192, 8192 } }
    };
    guac_display_plan plan = { .ops = ops, .length = 4 };
    guac_display_configure_worker_frame(display, &plan);
    CU_ASSERT_EQUAL(display->worker_active_limit, 2);
    display->worker_workload_aware = 0;
    guac_display_configure_worker_frame(display, &plan);
    CU_ASSERT_EQUAL(display->worker_active_limit, 22);
    display->worker_workload_aware = 1;
    display->worker_thread_count = 1;
    guac_display_configure_worker_frame(display, &plan);
    CU_ASSERT_EQUAL(display->worker_active_limit, 1);
    guac_mem_free(display);
}

/** A stopped queue must not inspect/reset pool state or process a late plan. */
void test_display__worker_frame_policy_ignores_stopped_queue() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    guac_fifo_init(&display->ops, display->ops_items,
            GUAC_DISPLAY_WORKER_FIFO_SIZE, sizeof(guac_display_plan_operation));
    guac_display_plan plan = { .length = 1, .ops = NULL };
    display->worker_active_limit = 3;
    guac_fifo_invalidate(&display->ops);
    guac_fifo_lock(&display->ops);
    guac_display_configure_worker_frame(display, &plan);
    CU_ASSERT_EQUAL(display->worker_active_limit, 3);
    guac_fifo_unlock(&display->ops);
    guac_fifo_destroy(&display->ops);
    guac_mem_free(display);
}

typedef struct concurrency_fixture {
    guac_display* display;
    guac_flag ready;
    guac_flag release;
    guac_flag done;
    int count;
    int completed;
    int claimed;
    unsigned int maximum;
} concurrency_fixture;

/** Use the exact production dequeue/admission path with controlled work. */
static void* concurrency_worker(void* data) {
    concurrency_fixture* fixture = data;
    guac_display* display = fixture->display;
    guac_display_plan_operation op;
    while (guac_display_worker_dequeue_and_lock(display, &op)) {
        display->active_workers++;
        fixture->claimed++;
        if (display->active_workers > fixture->maximum)
            fixture->maximum = display->active_workers;
        if (display->active_workers == (unsigned int) display->worker_active_limit)
            guac_flag_set(&fixture->ready, 1);
        guac_fifo_unlock(&display->ops);

        guac_flag_wait_and_lock(&fixture->release, 1);
        guac_flag_unlock(&fixture->release);

        guac_fifo_lock(&display->ops);
        display->active_workers--;
        fixture->completed++;
        if (fixture->completed == fixture->count)
            guac_flag_set(&fixture->done, 1);
        pthread_cond_signal(&display->ops.state.value_changed);
        guac_fifo_unlock(&display->ops);
    }
    return NULL;
}

static void concurrency_init(concurrency_fixture* fixture, int count, int limit) {
    memset(fixture, 0, sizeof(*fixture));
    fixture->display = guac_mem_zalloc(sizeof(guac_display));
    fixture->count = count;
    fixture->display->worker_active_limit = limit;
    guac_fifo_init(&fixture->display->ops, fixture->display->ops_items,
            GUAC_DISPLAY_WORKER_FIFO_SIZE, sizeof(guac_display_plan_operation));
    guac_flag_init(&fixture->ready);
    guac_flag_init(&fixture->release);
    guac_flag_init(&fixture->done);
    guac_display_plan_operation op = { .type = GUAC_DISPLAY_PLAN_OPERATION_NOP };
    for (int i = 0; i < count; i++)
        guac_fifo_enqueue(&fixture->display->ops, &op);
}

static void concurrency_destroy(concurrency_fixture* fixture) {
    guac_fifo_destroy(&fixture->display->ops);
    guac_flag_destroy(&fixture->ready);
    guac_flag_destroy(&fixture->release);
    guac_flag_destroy(&fixture->done);
    guac_mem_free(fixture->display);
}

/** Capacity is checked before dequeue; every queued operation runs once. */
void test_display__worker_admission_bounds_and_drains_real_fifo() {
    concurrency_fixture fixture;
    concurrency_init(&fixture, 96, 3);
    pthread_t threads[16];
    int started = 0;
    for (; started < 16; started++) {
        int result = pthread_create(&threads[started], NULL,
                concurrency_worker, &fixture);
        CU_ASSERT_EQUAL(result, 0);
        if (result)
            break;
    }
    int ready = guac_flag_timedwait_and_lock(&fixture.ready, 1, 5000);
    CU_ASSERT_TRUE(ready);
    if (ready)
        guac_flag_unlock(&fixture.ready);
    guac_fifo_lock(&fixture.display->ops);
    CU_ASSERT_EQUAL(fixture.display->active_workers, 3);
    CU_ASSERT_EQUAL(fixture.claimed, 3);
    CU_ASSERT_EQUAL(fixture.display->ops.item_count, 93);
    guac_fifo_unlock(&fixture.display->ops);
    guac_flag_set(&fixture.release, 1);
    int done = guac_flag_timedwait_and_lock(&fixture.done, 1, 5000);
    CU_ASSERT_TRUE(done);
    if (done)
        guac_flag_unlock(&fixture.done);
    guac_fifo_invalidate(&fixture.display->ops);
    for (int i = 0; i < started; i++)
        pthread_join(threads[i], NULL);
    CU_ASSERT_EQUAL(fixture.maximum, 3);
    CU_ASSERT_EQUAL(fixture.completed, 96);
    CU_ASSERT_EQUAL(fixture.claimed, 96);
    CU_ASSERT_EQUAL(fixture.display->active_workers, 0);
    concurrency_destroy(&fixture);
}

/** Shutdown wakes empty/capacity waiters without letting them claim more work. */
void test_display__worker_admission_shutdown_wakes_capacity_waiters() {
    concurrency_fixture fixture;
    concurrency_init(&fixture, 16, 2);
    pthread_t threads[8];
    int started = 0;
    for (; started < 8; started++) {
        int result = pthread_create(&threads[started], NULL,
                concurrency_worker, &fixture);
        CU_ASSERT_EQUAL(result, 0);
        if (result)
            break;
    }
    int ready = guac_flag_timedwait_and_lock(&fixture.ready, 1, 5000);
    CU_ASSERT_TRUE(ready);
    if (ready)
        guac_flag_unlock(&fixture.ready);
    guac_fifo_invalidate(&fixture.display->ops);
    guac_flag_set(&fixture.release, 1);
    for (int i = 0; i < started; i++)
        pthread_join(threads[i], NULL);
    CU_ASSERT_EQUAL(fixture.maximum, 2);
    CU_ASSERT_EQUAL(fixture.claimed, 2);
    CU_ASSERT_EQUAL(fixture.completed, 2);
    CU_ASSERT_EQUAL(fixture.display->active_workers, 0);
    concurrency_destroy(&fixture);
}

/** Changing policy cannot revoke permits underneath an in-flight frame. */
void test_display__worker_policy_changes_only_subsequent_frame() {
    concurrency_fixture fixture;
    concurrency_init(&fixture, 0, 3);
    fixture.display->active_workers = 2;
    guac_display_set_worker_policy(fixture.display, 0);
    CU_ASSERT_EQUAL(fixture.display->worker_active_limit, 3);
    CU_ASSERT_EQUAL(fixture.display->active_workers, 2);
    CU_ASSERT_EQUAL(fixture.display->worker_workload_aware, 0);
    guac_display_set_worker_policy(fixture.display, 1);
    CU_ASSERT_EQUAL(fixture.display->worker_active_limit, 3);
    CU_ASSERT_EQUAL(fixture.display->worker_workload_aware, 1);
    guac_display_set_worker_policy(fixture.display, 16);
    CU_ASSERT_EQUAL(fixture.display->worker_medium_limit, 16);
    CU_ASSERT_EQUAL(fixture.display->worker_active_limit, 3);
    guac_display_set_worker_policy(fixture.display, 65);
    CU_ASSERT_EQUAL(fixture.display->worker_medium_limit, 16);
    guac_display_set_worker_policy(fixture.display, -1);
    CU_ASSERT_EQUAL(fixture.display->worker_medium_limit, 16);
    concurrency_destroy(&fixture);
}
