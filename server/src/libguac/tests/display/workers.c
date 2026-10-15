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

#include <errno.h>
#include <limits.h>

#include "../../display-priv.h"
#include "guacamole/client.h"
#include "guacamole/display.h"

static int workers_test_pthread_create(pthread_t* thread,
        const pthread_attr_t* attr, void* (*entrypoint)(void*), void* argument);
static void workers_test_stop(guac_display* display);
static void workers_test_abort(guac_client* client, guac_protocol_status status,
        const char* format, ...);
static void workers_test_log(guac_client* client, guac_client_log_level level,
        const char* format, ...);
static char* workers_test_getenv(const char* name);
static void* workers_test_alloc(size_t factor_count, const size_t* factors);

/* Inject only thread creation and terminal error handling. The actual count
 * parser, allocation, and startup loop are compiled directly from production.
 * No process-wide environment changes or real failing thread races are used. */
#define guac_display_select_worker_count workers_test_select
#define guac_display_start_workers workers_test_start
#define pthread_create workers_test_pthread_create
#define guac_display_stop workers_test_stop
#define guac_client_abort workers_test_abort
#define guac_client_log workers_test_log
#define getenv workers_test_getenv
#define PRIV_guac_mem_alloc workers_test_alloc
#include "../../display-workers.c"
#undef guac_display_select_worker_count
#undef guac_display_start_workers
#undef pthread_create
#undef guac_display_stop
#undef guac_client_abort
#undef guac_client_log
#undef getenv
#undef PRIV_guac_mem_alloc

static int created;
static int fail_at;
static int stopped;
static int aborted;
static int fail_allocation;

static void* workers_test_alloc(size_t factor_count, const size_t* factors) {
    return fail_allocation ? NULL : PRIV_guac_mem_alloc(factor_count, factors);
}

static int workers_test_pthread_create(pthread_t* thread, const pthread_attr_t* attr,
        void* (*entrypoint)(void*), void* argument) {
    if (created == fail_at)
        return EAGAIN;
    memset(thread, 0, sizeof(*thread));
    created++;
    return 0;
}

static void workers_test_stop(guac_display* display) {
    CU_ASSERT_EQUAL(display->worker_thread_count, 0);
    stopped++;
    guac_mem_free(display->worker_threads);
    display->worker_threads = NULL;
}

static void workers_test_abort(guac_client* client, guac_protocol_status status,
        const char* format, ...) {
    CU_ASSERT_EQUAL(status, GUAC_PROTOCOL_STATUS_SERVER_ERROR);
    aborted++;
}

static void workers_test_log(guac_client* client, guac_client_log_level level,
        const char* format, ...) {
}

static char* workers_test_getenv(const char* name) {
    CU_ASSERT_STRING_EQUAL(name, GUAC_DISPLAY_WORKER_THREADS_ENV);
    return "4";
}

/** Automatic mode retains affinity counts, with safe unavailable/huge limits. */
void test_display__worker_count_automatic_bounds() {
    const char* automatic[] = { NULL, "", "auto" };
    for (unsigned int i = 0; i < sizeof(automatic) / sizeof(*automatic); i++) {
        int invalid = 1;
        CU_ASSERT_EQUAL(workers_test_select(22, automatic[i], &invalid), 22);
        CU_ASSERT_EQUAL(invalid, 0);
        CU_ASSERT_EQUAL(workers_test_select(0, automatic[i], &invalid), 1);
        CU_ASSERT_EQUAL(invalid, 0);
        CU_ASSERT_EQUAL(workers_test_select(ULONG_MAX, automatic[i], &invalid), 64);
        CU_ASSERT_EQUAL(invalid, 0);
    }
}

/** Explicit counts can be benchmarked without depending on detected affinity. */
void test_display__worker_count_valid_override() {
    const char* counts[] = { "1", "2", "4", "8", "22", "64", "0004" };
    const int expected[] = { 1, 2, 4, 8, 22, 64, 4 };
    for (unsigned int i = 0; i < sizeof(counts) / sizeof(*counts); i++) {
        int invalid = 1;
        CU_ASSERT_EQUAL(workers_test_select(1, counts[i], &invalid), expected[i]);
        CU_ASSERT_EQUAL(invalid, 0);
    }
}

/** Signs, suffixes, whitespace, zero and overflowing integers fail closed. */
void test_display__worker_count_invalid_falls_back() {
    const char* invalid_counts[] = {
        "0", "000", "-1", "+2", " 4", "4 ", "4x", "2.5", "AUTO", "65",
        "999999999999999999999999999999999999999999999999999999999999999"
    };
    for (unsigned int i = 0;
            i < sizeof(invalid_counts) / sizeof(*invalid_counts); i++) {
        int invalid = 0;
        CU_ASSERT_EQUAL(workers_test_select(22, invalid_counts[i], &invalid), 22);
        CU_ASSERT_EQUAL(invalid, 1);
        CU_ASSERT_EQUAL(workers_test_select(0, invalid_counts[i], &invalid), 1);
        CU_ASSERT_EQUAL(invalid, 1);
    }
}

static guac_display* workers_test_pool(int fail) {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    guac_client client = { 0 };
    display->client = &client;
    created = stopped = aborted = 0;
    fail_at = fail;
    workers_test_start(display);
    display->client = NULL;
    return display;
}

/** Every created worker is counted, so stop() joins exactly these handles. */
void test_display__worker_pool_success() {
    guac_display* display = workers_test_pool(-1);
    CU_ASSERT_EQUAL(created, 4);
    CU_ASSERT_EQUAL(display->worker_thread_count, 4);
    CU_ASSERT_EQUAL(stopped, 0);
    CU_ASSERT_EQUAL(aborted, 0);
    guac_mem_free(display->worker_threads);
    guac_mem_free(display);
}

/** Resource exhaustion preserves a smaller pool and no invalid thread IDs. */
void test_display__worker_pool_partial_creation() {
    guac_display* display = workers_test_pool(2);
    CU_ASSERT_EQUAL(created, 2);
    CU_ASSERT_EQUAL(display->worker_thread_count, 2);
    CU_ASSERT_EQUAL(stopped, 0);
    CU_ASSERT_EQUAL(aborted, 0);
    guac_mem_free(display->worker_threads);
    guac_mem_free(display);
}

/** A zero-worker pool cannot leave producers or later cleanup waiting forever. */
void test_display__worker_pool_creation_failure_stops() {
    guac_display* display = workers_test_pool(0);
    CU_ASSERT_EQUAL(created, 0);
    CU_ASSERT_EQUAL(display->worker_thread_count, 0);
    CU_ASSERT_EQUAL(stopped, 1);
    CU_ASSERT_EQUAL(aborted, 1);
    CU_ASSERT_PTR_NULL(display->worker_threads);
    guac_mem_free(display);
}

/** Allocation failure stops before dereferencing the pool or creating a thread. */
void test_display__worker_pool_allocation_failure_stops() {
    fail_allocation = 1;
    guac_display* display = workers_test_pool(-1);
    fail_allocation = 0;
    CU_ASSERT_EQUAL(created, 0);
    CU_ASSERT_EQUAL(display->worker_thread_count, 0);
    CU_ASSERT_EQUAL(stopped, 1);
    CU_ASSERT_EQUAL(aborted, 1);
    CU_ASSERT_PTR_NULL(display->worker_threads);
    guac_mem_free(display);
}
