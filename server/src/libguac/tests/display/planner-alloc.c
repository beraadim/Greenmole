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

#include "../../display-plan.h"
#include "../../display-priv.h"
#include "guacamole/client.h"
#include "guacamole/mem.h"
#include "guacamole/protocol-types.h"

/** Allocation fault injection is confined to this copy of planner storage. */
static int planner_alloc_fail_after;
static int planner_alloc_live;
static int planner_alloc_aborts;

static void* planner_fault_allocate(size_t count, const size_t* factors) {
    if (planner_alloc_fail_after == 0)
        return NULL;
    if (planner_alloc_fail_after > 0)
        planner_alloc_fail_after--;
    void* allocation = PRIV_guac_mem_alloc(count, factors);
    if (allocation != NULL)
        planner_alloc_live++;
    return allocation;
}

static void* planner_fault_zallocate(size_t count, const size_t* factors) {
    if (planner_alloc_fail_after == 0)
        return NULL;
    if (planner_alloc_fail_after > 0)
        planner_alloc_fail_after--;
    void* allocation = PRIV_guac_mem_zalloc(count, factors);
    if (allocation != NULL)
        planner_alloc_live++;
    return allocation;
}

static void planner_fault_free(void* allocation) {
    if (allocation != NULL)
        planner_alloc_live--;
    guac_mem_free(allocation);
}

static void planner_fault_abort(guac_client* client, guac_protocol_status status,
        const char* format, ...) {
    CU_ASSERT_EQUAL(status, GUAC_PROTOCOL_STATUS_SERVER_ERROR);
    planner_alloc_aborts++;
    client->state = GUAC_CLIENT_STOPPING;
}

#define PRIV_guac_mem_alloc planner_fault_allocate
#define PRIV_guac_mem_zalloc planner_fault_zallocate
#define PRIV_guac_mem_free planner_fault_free
#define guac_client_abort planner_fault_abort
#define PFW_guac_display_plan_alloc planner_fault_plan_alloc
#define guac_display_plan_free planner_fault_plan_free
#define guac_display_plan_reset_index planner_fault_reset_index
#define PFW_guac_display_plan_destroy_storage planner_fault_destroy_storage
#define guac_display_get_planner_statistics planner_fault_get_statistics
#include "../../display-plan-storage.c"
#undef guac_display_get_planner_statistics
#undef PFW_guac_display_plan_destroy_storage
#undef guac_display_plan_reset_index
#undef guac_display_plan_free
#undef PFW_guac_display_plan_alloc
#undef guac_client_abort
#undef PRIV_guac_mem_free
#undef PRIV_guac_mem_zalloc
#undef PRIV_guac_mem_alloc

/** Each failed new plan allocation stops the client and releases partial work. */
void test_display__planner_failed_allocations_release_partial_storage() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    guac_client client = { 0 };
    display->client = &client;
    planner_alloc_live = planner_alloc_aborts = 0;
    for (int allowed = 0; allowed < 2; allowed++) {
        planner_alloc_fail_after = allowed;
        client.state = GUAC_CLIENT_RUNNING;
        CU_ASSERT_TRUE(planner_fault_plan_alloc(display, 1) == NULL);
        CU_ASSERT_TRUE(display->plan_cache == NULL);
        CU_ASSERT_EQUAL(client.state, GUAC_CLIENT_STOPPING);
        CU_ASSERT_EQUAL(planner_alloc_live, 0);
    }
    CU_ASSERT_EQUAL(planner_alloc_aborts, 2);
    guac_mem_free(display);
}

/** Failed growth or nested allocation cannot destroy or alias cached storage. */
void test_display__planner_failed_growth_preserves_existing_storage() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    guac_client client = { 0 };
    display->client = &client;
    planner_alloc_live = planner_alloc_aborts = 0;
    planner_alloc_fail_after = -1;
    guac_display_plan* plan = planner_fault_plan_alloc(display, 1);
    CU_ASSERT_PTR_NOT_NULL_FATAL(plan);
    guac_display_plan_operation* original_ops = plan->ops;
    uint64_t retained = display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES];
    planner_fault_plan_free(plan);
    planner_alloc_fail_after = 0;
    CU_ASSERT_TRUE(planner_fault_plan_alloc(display, 65) == NULL);
    CU_ASSERT_TRUE(display->plan_cache == plan);
    CU_ASSERT_TRUE(plan->ops == original_ops);
    CU_ASSERT_EQUAL(plan->capacity, 64);
    CU_ASSERT_EQUAL(plan->in_use, 0);
    CU_ASSERT_EQUAL(planner_alloc_live, 2);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES], retained);
    planner_alloc_fail_after = -1;
    client.state = GUAC_CLIENT_RUNNING;
    CU_ASSERT_TRUE(planner_fault_plan_alloc(display, 1) == plan);
    planner_alloc_fail_after = 1;
    CU_ASSERT_TRUE(planner_fault_plan_alloc(display, 1) == NULL);
    CU_ASSERT_TRUE(display->plan_cache == plan);
    CU_ASSERT_TRUE(plan->ops == original_ops);
    CU_ASSERT_EQUAL(plan->in_use, 1);
    CU_ASSERT_EQUAL(planner_alloc_live, 2);
    planner_fault_plan_free(plan);
    planner_fault_destroy_storage(display);
    CU_ASSERT_EQUAL(planner_alloc_aborts, 2);
    CU_ASSERT_EQUAL(planner_alloc_live, 0);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES], 0);
    guac_mem_free(display);
}
