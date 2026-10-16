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

#include "../../user-handlers.h"
#include "guacamole/client.h"
#include "guacamole/timestamp.h"
#include <CUnit/CUnit.h>
#include <inttypes.h>
#include <stdio.h>

static int sync_handler_calls;
static guac_timestamp sync_handler_timestamp;
static int accepted_sync(guac_user* user, guac_timestamp timestamp) {
    (void) user;
    sync_handler_calls++;
    sync_handler_timestamp = timestamp;
    return 17;
}

void test_user__sync_handler_rejects_malformed_and_future() {
    guac_client client = { .last_sent_timestamp = 500 };
    guac_user user = { .client = &client, .sync_handler = accepted_sync,
        .last_received_timestamp = 100 };
    sync_handler_calls = 0;
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 0, NULL), -1);
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 1, NULL), -1);
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 2, NULL), -1);
    char* invalid[] = { NULL, "", "-1", "+1", "1x", "9223372036854775808", "501" };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        char* args[] = { invalid[i] };
        CU_ASSERT_EQUAL(__guac_handle_sync(&user, 1, args), -1);
    }
    CU_ASSERT_EQUAL(sync_handler_calls, 0);
    CU_ASSERT_EQUAL(user.last_received_timestamp, 100);
}

void test_user__sync_handler_preserves_fresh_duplicate_and_stale_callbacks() {
    guac_timestamp now = guac_timestamp_current();
    guac_client client = { .last_sent_timestamp = now };
    guac_user user = { .client = &client, .sync_handler = accepted_sync,
        .last_received_timestamp = now - 20 };
    char value[32];
    char* args[] = { value };
    snprintf(value, sizeof(value), "%" PRId64, now - 10);
    sync_handler_calls = 0;
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 1, args), 17);
    CU_ASSERT_EQUAL(user.last_received_timestamp, now - 10);
    CU_ASSERT_EQUAL(sync_handler_timestamp, now - 10);
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 1, args), 17);
    int baseline = user.last_frame_duration;
    int lag = user.processing_lag;
    snprintf(value, sizeof(value), "%" PRId64, now - 15);
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 1, args), 17);
    CU_ASSERT_EQUAL(user.last_received_timestamp, now - 10);
    CU_ASSERT_EQUAL(user.last_frame_duration, baseline);
    CU_ASSERT_EQUAL(user.processing_lag, lag);
    CU_ASSERT_EQUAL(sync_handler_timestamp, now - 15);
    CU_ASSERT_EQUAL(sync_handler_calls, 3);
    user.sync_handler = NULL;
    CU_ASSERT_EQUAL(__guac_handle_sync(&user, 1, args), 0);
}
