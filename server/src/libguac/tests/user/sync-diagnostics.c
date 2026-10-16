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

#include "../../user-sync-diagnostics.h"
#include "guacamole/client.h"
#include <CUnit/CUnit.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

static char* setting;
static int fail_allocation;
static int logs;
static char* sync_getenv(const char* name) {
    CU_ASSERT_STRING_EQUAL(name, "GUAC_DISPLAY_DIAGNOSTICS");
    return setting;
}
static void* sync_calloc(size_t count, size_t size) {
    return fail_allocation ? NULL : calloc(count, size);
}
static void sync_log(guac_user* user, guac_client_log_level level, const char* format, ...) {
    (void) user;
    CU_ASSERT_EQUAL(level, GUAC_LOG_DEBUG);
    CU_ASSERT_PTR_NOT_NULL(strstr(format, "ack_age_sum_ms="));
    logs++;
}
#define getenv sync_getenv
#define calloc sync_calloc
#define guac_user_log sync_log
#define guac_user_sync_diagnostics_init sync_test_init
#define guac_user_sync_diagnostics_free sync_test_free
#define guac_user_sync_diagnostics_record sync_test_record
#define guac_user_sync_parse_timestamp sync_test_parse
#define guac_user_sync_elapsed sync_test_elapsed
#include "../../user-sync-diagnostics.c"
#undef getenv
#undef calloc
#undef guac_user_log

void test_user__sync_diagnostics_opt_in() {
    guac_user user = { 0 };
    const char* disabled[] = { NULL, "", "0", "true", "01", "1 " };
    for (unsigned i = 0; i < sizeof(disabled) / sizeof(disabled[0]); i++) {
        setting = (char*) disabled[i];
        sync_test_init(&user);
        CU_ASSERT_PTR_NULL(user.__sync_diagnostics);
        sync_test_record(&user, 50000, 100, 50);
    }
    setting = "1";
    fail_allocation = 1;
    sync_test_init(&user);
    CU_ASSERT_PTR_NULL(user.__sync_diagnostics);
    fail_allocation = 0;
    sync_test_init(&user);
    CU_ASSERT_PTR_NOT_NULL(user.__sync_diagnostics);
    sync_test_free(&user);
    CU_ASSERT_PTR_NULL(user.__sync_diagnostics);
    sync_test_free(&user);
}

void test_user__sync_diagnostics_numeric_and_bounded() {
    guac_user user = { 0 };
    guac_client client = { 0 };
    user.client = &client;
    user.last_frame_duration = 20;
    user.processing_lag = 15;
    client.last_sent_timestamp = 450;
    setting = "1";
    logs = 0;
    sync_test_init(&user);
    guac_sync_diagnostics* stats = user.__sync_diagnostics;
    sync_test_record(&user, 1000, 400, 300);
    sync_test_record(&user, 1100, 400, 400);
    sync_test_record(&user, 1200, 399, 400);
    CU_ASSERT_EQUAL(stats->advancing, 1);
    CU_ASSERT_EQUAL(stats->duplicate, 1);
    CU_ASSERT_EQUAL(stats->stale, 1);
    CU_ASSERT_EQUAL(stats->ack_age_sum, 600);
    CU_ASSERT_EQUAL(stats->ack_age_max, 600);
    CU_ASSERT_EQUAL(stats->rtt_max, 20);
    CU_ASSERT_EQUAL(stats->processing_max, 15);
    CU_ASSERT_EQUAL(stats->unacknowledged_span_max, 50);
    for (int now = 1300; now < 21000; now++)
        sync_test_record(&user, now, 400, 400);
    CU_ASSERT_EQUAL(logs, 1);
    sync_test_record(&user, 21000, 400, 400);
    CU_ASSERT_EQUAL(logs, 2);
    sync_test_record(&user, -1, 400, 400);
    sync_test_record(&user, 100, 400, 400);
    CU_ASSERT_EQUAL(logs, 2);
    stats->advancing = UINT64_MAX;
    stats->ack_age_sum = UINT64_MAX - 2;
    sync_test_record(&user, 22000, 401, 400);
    CU_ASSERT_EQUAL(stats->advancing, UINT64_MAX);
    CU_ASSERT_EQUAL(stats->ack_age_sum, UINT64_MAX);
    sync_test_free(&user);
}

void test_user__sync_timestamp_validation_and_elapsed() {
    guac_timestamp timestamp = 17;
    const char* invalid[] = { NULL, "", "-1", "+1", " 1", "1 ", "1x", "1.2",
        "9223372036854775808", "18446744073709551616", "999999999999999999999999999" };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        CU_ASSERT_FALSE(sync_test_parse(invalid[i], &timestamp));
        CU_ASSERT_EQUAL(timestamp, 17);
    }
    CU_ASSERT_FALSE(sync_test_parse("1", NULL));
    CU_ASSERT_TRUE(sync_test_parse("0", &timestamp));
    CU_ASSERT_EQUAL(timestamp, 0);
    CU_ASSERT_TRUE(sync_test_parse("9223372036854775807", &timestamp));
    CU_ASSERT_EQUAL(timestamp, INT64_MAX);
    CU_ASSERT_TRUE(sync_test_parse("00012", &timestamp));
    CU_ASSERT_EQUAL(timestamp, 12);
    CU_ASSERT_EQUAL(sync_test_elapsed(1234, 1200), 34);
    CU_ASSERT_EQUAL(sync_test_elapsed(1200, 1234), 0);
    CU_ASSERT_EQUAL(sync_test_elapsed(INT64_MAX, 0), INT_MAX);
    CU_ASSERT_EQUAL(sync_test_elapsed(INT64_MAX, INT64_MIN), INT_MAX);
}
