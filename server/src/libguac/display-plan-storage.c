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
#include "guacamole/mem.h"
#include "guacamole/protocol-types.h"
#include "guacamole/rwlock.h"

#include <string.h>

void guac_display_plan_reset_index(guac_display_plan* plan) {
    for (size_t i = 0; i < plan->touched_count; i++) {
        size_t index = plan->touched_indices[i];
        plan->ops_by_hash[index].op = NULL;
        plan->occupied_buckets[index / 64] &= ~(UINT64_C(1) << (index % 64));
    }
    plan->display->planner_statistics[GUAC_DISPLAY_PLANNER_BUCKETS_CLEARED]
        += plan->touched_count;
    plan->touched_count = 0;
    plan->indexed_count = 0;
}

guac_display_plan* PFW_guac_display_plan_alloc(guac_display* display,
        size_t length) {

    guac_display_plan* plan = display->plan_cache;
    int reusable = length <= GUAC_DISPLAY_PLAN_CACHED_OPS
        && (plan == NULL || !plan->in_use);
    int allocated = !reusable || plan == NULL;

    if (allocated) {
        /* A new index is zeroed once. Later frames clear only touched buckets. */
        plan = guac_mem_zalloc(sizeof(guac_display_plan));
        if (plan == NULL)
            goto failed;
        plan->display = display;
        display->planner_statistics[GUAC_DISPLAY_PLANNER_PLAN_ALLOCATIONS]++;
    }

    if (plan->capacity < length) {
        size_t capacity = length;
        if (reusable) {
            capacity = 64;
            while (capacity < length)
                capacity *= 2;
        }
        guac_display_plan_operation* ops = guac_mem_alloc(capacity,
                sizeof(guac_display_plan_operation));
        if (ops == NULL) {
            if (allocated)
                guac_mem_free(plan);
            goto failed;
        }
        guac_mem_free(plan->ops);
        plan->ops = ops;
        plan->capacity = capacity;
        display->planner_statistics[GUAC_DISPLAY_PLANNER_OP_ALLOCATIONS]++;
    }

    if (reusable) {
        display->plan_cache = plan;
        display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES]
            = sizeof(guac_display_plan)
                + plan->capacity * sizeof(guac_display_plan_operation);
        if (!allocated)
            display->planner_statistics[GUAC_DISPLAY_PLANNER_PLAN_REUSES]++;
    }

    plan->length = length;
    plan->in_use = 1;
    return plan;

failed:
    /* No partially constructed plan can reach the commit/encoding path. */
    guac_client_abort(display->client, GUAC_PROTOCOL_STATUS_SERVER_ERROR,
            "Unable to allocate display planning storage.");
    return NULL;

}

void guac_display_plan_free(guac_display_plan* plan) {
    guac_display_plan_reset_index(plan);
    plan->in_use = 0;
    plan->length = 0;
    if (plan != plan->display->plan_cache) {
        guac_mem_free(plan->ops);
        guac_mem_free(plan);
    }
}

void PFW_guac_display_plan_destroy_storage(guac_display* display) {
    guac_display_plan* plan = display->plan_cache;
    if (plan != NULL) {
        GUAC_ASSERT(!plan->in_use);
        guac_mem_free(plan->ops);
        guac_mem_free(plan);
        display->plan_cache = NULL;
    }
    display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES] = 0;
}

int guac_display_get_planner_statistics(guac_display* display,
        uint64_t* values, size_t count) {
    if (display == NULL || values == NULL
            || count != GUAC_DISPLAY_PLANNER_STATISTIC_COUNT)
        return 0;
    guac_rwlock_acquire_read_lock(&display->pending_frame.lock);
    memcpy(values, display->planner_statistics,
            sizeof(display->planner_statistics));
    guac_rwlock_release_lock(&display->pending_frame.lock);
    return 1;
}
