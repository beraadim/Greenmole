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

#include "user-sync-diagnostics.h"
#include "guacamole/client.h"

#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define SYNC_DIAGNOSTICS_INTERVAL_MS UINT64_C(10000)

typedef struct guac_sync_diagnostics {
    uint64_t advancing, duplicate, stale;
    uint64_t ack_age_sum, ack_age_max;
    uint64_t rtt_max, processing_max, unacknowledged_span_max;
    uint64_t last_log;
    int started;
} guac_sync_diagnostics;

static uint64_t add(uint64_t a, uint64_t b) {
    return UINT64_MAX - a < b ? UINT64_MAX : a + b;
}

static uint64_t maximum(uint64_t a, uint64_t b) {
    return a > b ? a : b;
}

int guac_user_sync_elapsed(guac_timestamp now, guac_timestamp timestamp) {
    if (now <= timestamp) return 0;
    uint64_t elapsed = (uint64_t) now - (uint64_t) timestamp;
    return elapsed > INT_MAX ? INT_MAX : (int) elapsed;
}

int guac_user_sync_parse_timestamp(const char* value, guac_timestamp* timestamp) {
    uint64_t result = 0;
    if (!value || !*value || !timestamp)
        return 0;
    for (; *value; value++) {
        if (*value < '0' || *value > '9')
            return 0;
        unsigned digit = *value - '0';
        if (result > ((uint64_t) INT64_MAX - digit) / 10)
            return 0;
        result = result * 10 + digit;
    }
    *timestamp = (guac_timestamp) result;
    return 1;
}

void guac_user_sync_diagnostics_init(guac_user* user) {
    const char* setting = getenv("GUAC_DISPLAY_DIAGNOSTICS");
    if (setting && !strcmp(setting, "1"))
        user->__sync_diagnostics = calloc(1, sizeof(guac_sync_diagnostics));
    /* Allocation failure only disables these optional statistics. */
}

void guac_user_sync_diagnostics_free(guac_user* user) {
    free(user->__sync_diagnostics);
    user->__sync_diagnostics = NULL;
}

void guac_user_sync_diagnostics_record(guac_user* user, guac_timestamp now,
        guac_timestamp timestamp, guac_timestamp previous) {
    guac_sync_diagnostics* stats = user->__sync_diagnostics;
    if (!stats || now < 0)
        return;
    uint64_t current = (uint64_t) now;
    if (!stats->started) {
        stats->last_log = current;
        stats->started = 1;
    }
    if (timestamp > previous) {
        uint64_t age = now >= timestamp ? (uint64_t) now - (uint64_t) timestamp : 0;
        uint64_t span = user->client->last_sent_timestamp >= timestamp
            ? (uint64_t) user->client->last_sent_timestamp - (uint64_t) timestamp : 0;
        stats->advancing = add(stats->advancing, 1);
        stats->ack_age_sum = add(stats->ack_age_sum, age);
        stats->ack_age_max = maximum(stats->ack_age_max, age);
        stats->rtt_max = maximum(stats->rtt_max,
                user->last_frame_duration > 0 ? user->last_frame_duration : 0);
        stats->processing_max = maximum(stats->processing_max,
                user->processing_lag > 0 ? user->processing_lag : 0);
        stats->unacknowledged_span_max = maximum(stats->unacknowledged_span_max, span);
    }
    else if (timestamp == previous)
        stats->duplicate = add(stats->duplicate, 1);
    else
        stats->stale = add(stats->stale, 1);

    /* No timer or additional clock read; emit only on inbound sync activity.
     * These are cumulative counters/gauges in the server timestamp domain.
     * An ACK age includes server send, bridge, network and browser processing. */
    if (current >= stats->last_log
            && current - stats->last_log >= SYNC_DIAGNOSTICS_INTERVAL_MS) {
        stats->last_log = current;
        guac_user_log(user, GUAC_LOG_DEBUG,
            "Sync diagnostics: advancing=%" PRIu64 " duplicate=%" PRIu64
            " stale=%" PRIu64 " ack_age_sum_ms=%" PRIu64
            " ack_age_max_ms=%" PRIu64 " estimated_rtt_max_ms=%" PRIu64
            " processing_lag_max_ms=%" PRIu64 " unacknowledged_span_max_ms=%" PRIu64,
            stats->advancing, stats->duplicate, stats->stale,
            stats->ack_age_sum, stats->ack_age_max, stats->rtt_max,
            stats->processing_max, stats->unacknowledged_span_max);
    }
}
