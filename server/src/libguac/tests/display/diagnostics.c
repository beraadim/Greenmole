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

#include "../../display-priv.h"

#include <CUnit/CUnit.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static char* diagnostics_test_getenv(const char* name);
static int diagnostics_test_clock_gettime(clockid_t clock, struct timespec* now);
#if !(defined(HAVE_CLOCK_GETTIME) && defined(CLOCK_MONOTONIC))
static int diagnostics_test_gettimeofday(struct timeval* now, void* zone);
#endif
#ifndef GUAC_THREAD_LOCAL
static int diagnostics_test_setspecific(pthread_key_t key, const void* value);
static void* diagnostics_test_calloc(size_t count, size_t size);
#endif
static void diagnostics_test_log(guac_client* client, guac_client_log_level level,
        const char* format, ...);
static int diagnostics_test_blob(guac_socket* socket, const guac_stream* stream,
        const void* data, int length);
void diagnostics_test_fail(guac_display* display);

/* Run production diagnostics with deterministic clocks and fault injection.
 * No environment mutation, real connection, or real failing allocator needed. */
#define guac_display_diagnostics_init diagnostics_test_init
#define guac_display_diagnostics_now diagnostics_test_now
#define guac_display_diagnostics_elapsed diagnostics_test_elapsed
#define guac_display_diagnostics_set_current diagnostics_test_set_current
#define guac_display_diagnostics_current diagnostics_test_current
#define guac_display_diagnostics_send_blob_timed diagnostics_test_send_blob
#define guac_display_diagnostics_fail diagnostics_test_fail
#define guac_display_diagnostics_record_image diagnostics_test_record_image
#define guac_display_diagnostics_finish_frame diagnostics_test_finish_frame
#define guac_display_get_render_statistics diagnostics_test_get_statistics
#define getenv diagnostics_test_getenv
#define clock_gettime diagnostics_test_clock_gettime
#define gettimeofday diagnostics_test_gettimeofday
#define pthread_setspecific diagnostics_test_setspecific
#define calloc diagnostics_test_calloc
#define guac_client_log diagnostics_test_log
#define guac_protocol_send_blob diagnostics_test_blob
#include "../../display-diagnostics.c"
#undef guac_display_diagnostics_init
#undef guac_display_diagnostics_now
#undef guac_display_diagnostics_elapsed
#undef guac_display_diagnostics_set_current
#undef guac_display_diagnostics_current
#undef guac_display_diagnostics_send_blob_timed
#undef guac_display_diagnostics_fail
#undef guac_display_diagnostics_record_image
#undef guac_display_diagnostics_finish_frame
#undef guac_display_get_render_statistics
#undef getenv
#undef clock_gettime
#undef gettimeofday
#undef pthread_setspecific
#undef calloc
#undef guac_client_log
#undef guac_protocol_send_blob

static char* diagnostics_setting;
static uint64_t diagnostics_clock = 100;
static int diagnostics_clock_calls;
static int diagnostics_clock_failure;
#ifndef GUAC_THREAD_LOCAL
static int diagnostics_allocation_failure;
static int diagnostics_tls_failure;
#endif
static int diagnostics_warning_logs;
static int diagnostics_debug_logs;
static const void* diagnostics_blob_data;
static int diagnostics_blob_length;

static char* diagnostics_test_getenv(const char* name) {
    CU_ASSERT_STRING_EQUAL(name, GUAC_DISPLAY_DIAGNOSTICS_ENV);
    return diagnostics_setting;
}

static int diagnostics_test_clock_gettime(clockid_t clock, struct timespec* now) {
    diagnostics_clock_calls++;
    if (diagnostics_clock_failure)
        return -1;
    now->tv_sec = diagnostics_clock / 1000000;
    now->tv_nsec = (diagnostics_clock % 1000000) * 1000;
    diagnostics_clock += 10;
    return 0;
}

#if !(defined(HAVE_CLOCK_GETTIME) && defined(CLOCK_MONOTONIC))
static int diagnostics_test_gettimeofday(struct timeval* now, void* zone) {
    struct timespec precise;
    if (diagnostics_test_clock_gettime(0, &precise))
        return -1;
    now->tv_sec = precise.tv_sec;
    now->tv_usec = precise.tv_nsec / 1000;
    return 0;
}
#endif

#ifndef GUAC_THREAD_LOCAL
static int diagnostics_test_setspecific(pthread_key_t key, const void* value) {
    return diagnostics_tls_failure ? ENOMEM : pthread_setspecific(key, value);
}

static void* diagnostics_test_calloc(size_t count, size_t size) {
    return diagnostics_allocation_failure ? NULL : calloc(count, size);
}
#endif

static void diagnostics_test_log(guac_client* client, guac_client_log_level level,
        const char* format, ...) {
    if (level == GUAC_LOG_WARNING)
        diagnostics_warning_logs++;
    if (level == GUAC_LOG_DEBUG)
        diagnostics_debug_logs++;
}

static int diagnostics_test_blob(guac_socket* socket, const guac_stream* stream,
        const void* data, int length) {
    diagnostics_blob_data = data;
    diagnostics_blob_length = length;
    return -17;
}

static guac_display* diagnostics_display(void) {
    guac_display* display = calloc(1, sizeof(*display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    guac_fifo_init(&display->ops, display->ops_items,
            GUAC_DISPLAY_WORKER_FIFO_SIZE, sizeof(guac_display_plan_operation));
    diagnostics_test_init(display);
    return display;
}

static void diagnostics_free(guac_display* display) {
    guac_fifo_destroy(&display->ops);
    free(display);
}

/** Defaults and invalid opt-ins perform no clock reads or timing publication. */
void test_display__diagnostics_default_off() {
    char* disabled[] = { NULL, "", "0", "true", " 1", "1 " };
    diagnostics_clock_calls = 0;
    for (size_t i = 0; i < sizeof(disabled) / sizeof(*disabled); i++) {
        diagnostics_setting = disabled[i];
        guac_display* display = diagnostics_display();
        uint64_t values[GUAC_DISPLAY_RENDER_STATISTIC_COUNT] = { 99 };
        CU_ASSERT_FALSE(display->diagnostics_enabled);
        CU_ASSERT_FALSE(diagnostics_test_get_statistics(display, values,
                    GUAC_DISPLAY_RENDER_STATISTIC_COUNT));
        CU_ASSERT_EQUAL(values[0], 99);
        diagnostics_free(display);
    }
    CU_ASSERT_EQUAL(diagnostics_clock_calls, 0);
}

/** Totals, gauges, and saturation are published under the existing FIFO lock. */
void test_display__diagnostics_numeric_snapshot() {
    diagnostics_setting = "1";
    guac_display* display = diagnostics_display();
    display->render_statistics[GUAC_DISPLAY_RENDER_PIXELS] = UINT64_MAX - 3;
    guac_display_render_sample sample = {
        .queue_us = 23, .lock_wait_us = 5, .format_us = 7, .stream_us = 50,
        .blob_send_us = 12, .encoded_bytes = 1234, .pixels = 10,
        .format = GUAC_DISPLAY_IMAGE_FORMAT_WEBP
    };
    guac_fifo_lock(&display->ops);
    diagnostics_test_record_image(display, &sample);
    sample.queue_us = 4;
    sample.stream_us = 20;
    diagnostics_test_record_image(display, &sample);
    display->diagnostics_batch_started_us = 100;
    diagnostics_test_finish_frame(display, 190, 200);
    guac_fifo_unlock(&display->ops);
    uint64_t values[GUAC_DISPLAY_RENDER_STATISTIC_COUNT] = { 99 };
    CU_ASSERT_FALSE(diagnostics_test_get_statistics(display, values, 15));
    CU_ASSERT_EQUAL(values[0], 99);
    CU_ASSERT_FALSE(diagnostics_test_get_statistics(NULL, values, 16));
    CU_ASSERT_FALSE(diagnostics_test_get_statistics(display, NULL, 16));
    CU_ASSERT_TRUE(diagnostics_test_get_statistics(display, values, 16));
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_IMAGES], 2);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_PIXELS], UINT64_MAX);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_QUEUE_US], 27);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_QUEUE_MAX_US], 23);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_STREAM_US], 70);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_STREAM_MAX_US], 50);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_BLOB_SEND_US], 24);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_ENCODED_BYTES], 2468);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_WEBP_IMAGES], 2);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_FRAMES], 1);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_FINISH_US], 10);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_RENDER_FRAME_ELAPSED_US], 100);
    CU_ASSERT_EQUAL(display->diagnostics_batch_started_us, 0);
    diagnostics_free(display);
}

/** Backwards clocks/failures cannot wrap a duration or mix timestamp domains. */
void test_display__diagnostics_clock_failure() {
    CU_ASSERT_EQUAL(diagnostics_test_elapsed(10, 9), 0);
    CU_ASSERT_EQUAL(diagnostics_test_elapsed(0, 500), 0);
    CU_ASSERT_EQUAL(diagnostics_test_elapsed(10, 0), 0);
    diagnostics_clock_failure = 1;
    diagnostics_clock_calls = 0;
    CU_ASSERT_EQUAL(diagnostics_test_now(), 0);
    CU_ASSERT_EQUAL(diagnostics_clock_calls, 1);
    diagnostics_clock_failure = 0;
    diagnostics_setting = "1";
    guac_display* display = diagnostics_display();
    diagnostics_warning_logs = 0;
    guac_display_render_sample sample = { .failed = 1 };
    guac_fifo_lock(&display->ops);
    diagnostics_test_record_image(display, &sample);
    diagnostics_test_record_image(display, &sample);
    guac_fifo_unlock(&display->ops);
    uint64_t values[16] = { 99 };
    CU_ASSERT_FALSE(diagnostics_test_get_statistics(display, values, 16));
    CU_ASSERT_EQUAL(values[0], 99);
    CU_ASSERT_EQUAL(diagnostics_warning_logs, 1);
    diagnostics_free(display);
}

static void* diagnostics_tls_thread(void* unused) {
    guac_display_render_sample sample = { 0 };
    CU_ASSERT_PTR_NULL(diagnostics_test_current());
#ifndef GUAC_THREAD_LOCAL
    diagnostics_allocation_failure = 1;
    CU_ASSERT_FALSE(diagnostics_test_set_current(&sample));
    CU_ASSERT_PTR_NULL(diagnostics_test_current());
    diagnostics_allocation_failure = 0;
    diagnostics_tls_failure = 1;
    CU_ASSERT_FALSE(diagnostics_test_set_current(&sample));
    CU_ASSERT_PTR_NULL(diagnostics_test_current());
    diagnostics_tls_failure = 0;
#endif
    CU_ASSERT_TRUE(diagnostics_test_set_current(&sample));
    CU_ASSERT_PTR_EQUAL(diagnostics_test_current(), &sample);
    /* Cleanup is independent of pthread_setspecific: force that API to fail. */
#ifndef GUAC_THREAD_LOCAL
    diagnostics_tls_failure = 1;
#endif
    CU_ASSERT_TRUE(diagnostics_test_set_current(NULL));
    CU_ASSERT_PTR_NULL(diagnostics_test_current());
#ifndef GUAC_THREAD_LOCAL
    diagnostics_tls_failure = 0;
#endif
    return NULL;
}

/** TLS setup fails closed; ending a scope cannot leave a stack pointer behind. */
void test_display__diagnostics_tls_isolation_and_failures() {
    guac_display_render_sample sample = { 0 };
    CU_ASSERT_TRUE(diagnostics_test_set_current(&sample));
    pthread_t thread;
    CU_ASSERT_EQUAL_FATAL(pthread_create(&thread, NULL, diagnostics_tls_thread, NULL), 0);
    CU_ASSERT_EQUAL(pthread_join(thread, NULL), 0);
    CU_ASSERT_PTR_EQUAL(diagnostics_test_current(), &sample);
    CU_ASSERT_TRUE(diagnostics_test_set_current(NULL));
    CU_ASSERT_PTR_NULL(diagnostics_test_current());
}

/** Blob instrumentation preserves the exact payload, byte count, and status. */
void test_display__diagnostics_blob_accounting() {
    guac_display_render_sample sample = { 0 };
    const char data[] = "binary\0data";
    diagnostics_clock_failure = 0;
    diagnostics_clock = 100;
    CU_ASSERT_EQUAL(diagnostics_test_send_blob(&sample, NULL, NULL,
                data, sizeof(data)), -17);
    CU_ASSERT_PTR_EQUAL(diagnostics_blob_data, data);
    CU_ASSERT_EQUAL(diagnostics_blob_length, sizeof(data));
    CU_ASSERT_EQUAL(sample.encoded_bytes, sizeof(data));
    CU_ASSERT_EQUAL(sample.blob_send_us, 10);
    CU_ASSERT_FALSE(sample.failed);
    diagnostics_clock_failure = 1;
    diagnostics_test_send_blob(&sample, NULL, NULL, data, sizeof(data));
    CU_ASSERT_TRUE(sample.failed);
    diagnostics_clock_failure = 0;
}

/** Enabling DEBUG does not create per-frame or per-image high-volume logs. */
void test_display__diagnostics_log_rate_limit() {
    diagnostics_setting = "1";
    diagnostics_clock = 100;
    guac_display* display = diagnostics_display();
    diagnostics_debug_logs = 0;
    guac_fifo_lock(&display->ops);
    for (uint64_t now = 1000; now <= 20000000; now += 1000) {
        display->diagnostics_batch_started_us = now - 20;
        diagnostics_test_finish_frame(display, now - 10, now);
    }
    guac_fifo_unlock(&display->ops);
    CU_ASSERT_EQUAL(diagnostics_debug_logs, 1);
    diagnostics_free(display);
}
