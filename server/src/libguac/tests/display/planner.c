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
#include "guacamole/fifo.h"
#include "guacamole/mem.h"
#include "guacamole/rwlock.h"

#include <stdint.h>
#include <string.h>

/* Exercise the real collision and early-exit helpers without exporting those
 * implementation details as new libguac entrypoints. */
#define PFR_guac_display_plan_index_dirty_cells planner_test_index_dirty_cells
#define PFR_LFR_guac_display_plan_rewrite_as_copies planner_test_rewrite_as_copies
#include "../../display-plan-search.c"
#undef PFR_guac_display_plan_index_dirty_cells
#undef PFR_LFR_guac_display_plan_rewrite_as_copies

static guac_display* planner_display_alloc(void) {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    guac_rwlock_init(&display->pending_frame.lock);
    return display;
}

static void planner_display_free(guac_display* display) {
    PFW_guac_display_plan_destroy_storage(display);
    guac_rwlock_destroy(&display->pending_frame.lock);
    guac_mem_free(display);
}

/** Retained storage grows geometrically, is bounded, and is never aliased. */
void test_display__planner_storage_reuse_is_bounded() {
    guac_display* display = planner_display_alloc();
    guac_display_plan* first = PFW_guac_display_plan_alloc(display, 1);
    CU_ASSERT_PTR_NOT_NULL_FATAL(first);
    CU_ASSERT_EQUAL(first->capacity, 64);
    guac_display_plan* nested = PFW_guac_display_plan_alloc(display, 1);
    CU_ASSERT_PTR_NOT_NULL_FATAL(nested);
    CU_ASSERT_TRUE(nested != first);
    guac_display_plan_free(nested);
    guac_display_plan_free(first);
    guac_display_plan* next = PFW_guac_display_plan_alloc(display, 65);
    CU_ASSERT_TRUE(next == first);
    CU_ASSERT_EQUAL(next->capacity, 128);
    guac_display_plan_free(next);
    next = PFW_guac_display_plan_alloc(display, GUAC_DISPLAY_PLAN_CACHED_OPS);
    CU_ASSERT_TRUE(next == first);
    CU_ASSERT_EQUAL(next->capacity, GUAC_DISPLAY_PLAN_CACHED_OPS);
    guac_display_plan_free(next);
    uint64_t retained = display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES];
    next = PFW_guac_display_plan_alloc(display, GUAC_DISPLAY_PLAN_CACHED_OPS + 1);
    CU_ASSERT_TRUE(next != first);
    CU_ASSERT_EQUAL(next->capacity, GUAC_DISPLAY_PLAN_CACHED_OPS + 1);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES], retained);
    guac_display_plan_free(next);
    CU_ASSERT_EQUAL(first->capacity, GUAC_DISPLAY_PLAN_CACHED_OPS);
    PFW_guac_display_plan_destroy_storage(display);
    CU_ASSERT_TRUE(display->plan_cache == NULL);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_RETAINED_BYTES], 0);
    planner_display_free(display);
}

/** Duplicate buckets count once; a different full hash cannot consume one. */
void test_display__planner_counts_hash_collisions_exactly() {
    guac_display* display = planner_display_alloc();
    guac_display_plan* plan = PFW_guac_display_plan_alloc(display, 2);
    guac_display_plan_store_indexed_op(plan, 1, &plan->ops[0]);
    guac_display_plan_store_indexed_op(plan, 0x10000, &plan->ops[1]);
    guac_display_plan_store_indexed_op(plan, 1, &plan->ops[1]);
    CU_ASSERT_EQUAL(plan->indexed_count, 1);
    CU_ASSERT_EQUAL(plan->touched_count, 1);
    CU_ASSERT_TRUE(guac_display_plan_remove_indexed_op(plan, 0x10000) == NULL);
    CU_ASSERT_EQUAL(plan->indexed_count, 1);
    CU_ASSERT_TRUE(guac_display_plan_remove_indexed_op(plan, 1) == &plan->ops[0]);
    CU_ASSERT_EQUAL(plan->indexed_count, 0);
    CU_ASSERT_TRUE(guac_display_plan_remove_indexed_op(plan, 1) == NULL);
    guac_display_plan_free(plan);
    CU_ASSERT_EQUAL(plan->touched_count, 0);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_BUCKETS_CLEARED], 1);
    plan = PFW_guac_display_plan_alloc(display, 2);
    guac_display_plan_store_indexed_op(plan, 0x10000, &plan->ops[1]);
    CU_ASSERT_TRUE(guac_display_plan_remove_indexed_op(plan, 0x10000) == &plan->ops[1]);
    guac_display_plan_free(plan);
    planner_display_free(display);
}

static void planner_layer_init(guac_display* display, guac_display_layer* layer,
        uint32_t* pending, uint32_t* previous, int width, int height) {
    memset(layer, 0, sizeof(*layer));
    layer->display = display;
    layer->pending_frame = (guac_display_layer_state) {
        .width = width, .height = height, .buffer = (unsigned char*) pending,
        .buffer_stride = width * sizeof(uint32_t), .search_for_copies = 1,
        .dirty = { 0, 0, width, height }
    };
    layer->last_frame = (guac_display_layer_state) {
        .width = width, .height = height, .buffer = (unsigned char*) previous,
        .buffer_stride = width * sizeof(uint32_t)
    };
}

static void planner_fill(uint32_t* pixels, size_t length, uint32_t seed) {
    for (size_t i = 0; i < length; i++) {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        pixels[i] = seed;
    }
}

/** All RECT/NOP and incomplete edge cells skip searches without reading pixels. */
void test_display__planner_skips_empty_copy_search() {
    guac_display* display = planner_display_alloc();
    guac_display_layer layer;
    planner_layer_init(display, &layer, NULL, NULL, 63, 64);
    display->last_frame.layers = &layer;
    guac_display_plan* plan = PFW_guac_display_plan_alloc(display, 3);
    plan->ops[0] = (guac_display_plan_operation) { .type = GUAC_DISPLAY_PLAN_OPERATION_RECT };
    plan->ops[1] = (guac_display_plan_operation) { .type = GUAC_DISPLAY_PLAN_OPERATION_NOP };
    plan->ops[2] = (guac_display_plan_operation) {
        .type = GUAC_DISPLAY_PLAN_OPERATION_IMG, .layer = &layer,
        .dest = { 0, 0, 63, 64 }
    };
    planner_test_index_dirty_cells(plan);
    planner_test_rewrite_as_copies(plan);
    CU_ASSERT_EQUAL(plan->indexed_count, 0);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_SEARCH_WINDOWS], 0);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_EMPTY_SEARCHES], 1);
    CU_ASSERT_EQUAL(plan->ops[2].type, GUAC_DISPLAY_PLAN_OPERATION_IMG);
    guac_display_plan_free(plan);
    planner_display_free(display);
}

/** A unique hit stops at the row boundary and prevents later layer scans. */
void test_display__planner_stops_when_copy_candidates_exhausted() {
    guac_display* display = planner_display_alloc();
    uint32_t pending[128 * 128];
    uint32_t previous[128 * 128];
    planner_fill(previous, 128 * 128, 123);
    memcpy(pending, previous, sizeof(pending));
    guac_display_layer layer, unreadable_next;
    planner_layer_init(display, &layer, pending, previous, 128, 128);
    planner_layer_init(display, &unreadable_next, NULL, NULL, 128, 128);
    layer.last_frame.next = &unreadable_next;
    display->last_frame.layers = &layer;
    guac_display_plan* plan = PFW_guac_display_plan_alloc(display, 2);
    for (int i = 0; i < 2; i++)
        plan->ops[i] = (guac_display_plan_operation) {
            .layer = &layer, .type = GUAC_DISPLAY_PLAN_OPERATION_IMG,
            .dest = { 0, 0, 64, 64 }
        };
    planner_test_index_dirty_cells(plan);
    CU_ASSERT_EQUAL(plan->indexed_count, 1);
    planner_test_rewrite_as_copies(plan);
    CU_ASSERT_EQUAL(plan->ops[0].type, GUAC_DISPLAY_PLAN_OPERATION_COPY);
    CU_ASSERT_EQUAL(plan->ops[1].type, GUAC_DISPLAY_PLAN_OPERATION_IMG);
    CU_ASSERT_EQUAL(plan->indexed_count, 0);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_SEARCH_WINDOWS], 65);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_EXHAUSTED_SEARCHES], 1);
    guac_display_plan_free(plan);
    planner_display_free(display);
}

/** A miss still scans every possible window and keeps the image operation. */
void test_display__planner_miss_preserves_img_and_complete_search() {
    guac_display* display = planner_display_alloc();
    uint32_t pending[128 * 64];
    uint32_t previous[128 * 64];
    planner_fill(previous, 128 * 64, 123);
    planner_fill(pending, 128 * 64, 456);
    guac_display_layer layer;
    planner_layer_init(display, &layer, pending, previous, 128, 64);
    display->last_frame.layers = &layer;
    guac_display_plan* plan = PFW_guac_display_plan_alloc(display, 1);
    plan->ops[0] = (guac_display_plan_operation) {
        .layer = &layer, .type = GUAC_DISPLAY_PLAN_OPERATION_IMG,
        .dest = { 0, 0, 64, 64 }
    };
    planner_test_index_dirty_cells(plan);
    planner_test_rewrite_as_copies(plan);
    CU_ASSERT_EQUAL(plan->ops[0].type, GUAC_DISPLAY_PLAN_OPERATION_IMG);
    CU_ASSERT_EQUAL(plan->indexed_count, 1);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_SEARCH_WINDOWS], 65);
    guac_display_plan_free(plan);
    planner_display_free(display);
}

/** Full-hash collisions retain the exact pixel check and ban that candidate. */
void test_display__planner_hash_match_requires_identical_pixels() {
    guac_display* display = planner_display_alloc();
    uint32_t pending[64 * 64] = { 0 };
    uint32_t previous[64 * 64] = { 0 };
    pending[0] = 1;
    guac_display_layer layer;
    planner_layer_init(display, &layer, pending, previous, 64, 64);
    guac_display_plan* plan = PFW_guac_display_plan_alloc(display, 1);
    plan->ops[0] = (guac_display_plan_operation) {
        .layer = &layer, .type = GUAC_DISPLAY_PLAN_OPERATION_IMG,
        .dest = { 0, 0, 64, 64 }
    };
    guac_display_plan_store_indexed_op(plan, 123, &plan->ops[0]);
    PFR_LFR_guac_display_plan_find_copies(plan, 0, 0, 123, &layer);
    CU_ASSERT_EQUAL(plan->ops[0].type, GUAC_DISPLAY_PLAN_OPERATION_IMG);
    CU_ASSERT_EQUAL(plan->indexed_count, 0);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_COPY_MATCHES], 0);
    guac_display_plan_free(plan);
    planner_display_free(display);
}

/** Repeated resized plans replace every cell reference before using scratch. */
void test_display__planner_reuses_storage_across_resized_frames() {
    guac_display* display = planner_display_alloc();
    const int widths[] = { 64, 128, 1024, 65, 192, 64 };
    for (size_t n = 0; n < sizeof(widths) / sizeof(widths[0]); n++) {
        int width = widths[n], height = 128;
        size_t pixels = width * height;
        uint32_t* pending = guac_mem_alloc(pixels, sizeof(uint32_t));
        uint32_t* previous = guac_mem_zalloc(pixels, sizeof(uint32_t));
        planner_fill(pending, pixels, 123 + n);
        guac_display_layer layer;
        planner_layer_init(display, &layer, pending, previous, width, height);
        layer.pending_frame_cells_width = GUAC_DISPLAY_CELL_DIMENSION(width);
        layer.pending_frame_cells_height = GUAC_DISPLAY_CELL_DIMENSION(height);
        size_t cells = layer.pending_frame_cells_width * layer.pending_frame_cells_height;
        layer.pending_frame_cells = guac_mem_zalloc(cells, sizeof(guac_display_layer_cell));
        display->pending_frame.layers = &layer;
        guac_display_plan* plan = PFW_LFR_guac_display_plan_create(display);
        CU_ASSERT_PTR_NOT_NULL_FATAL(plan);
        CU_ASSERT_EQUAL(plan->length, cells);
        for (size_t i = 0; i < cells; i++)
            CU_ASSERT_TRUE(layer.pending_frame_cells[i].related_op == &plan->ops[i]);
        planner_test_index_dirty_cells(plan);
        guac_display_plan_free(plan);
        CU_ASSERT_EQUAL(plan->indexed_count, 0);
        CU_ASSERT_EQUAL(plan->touched_count, 0);
        for (size_t i = 0; i < GUAC_DISPLAY_PLAN_OPERATION_INDEX_SIZE; i++)
            CU_ASSERT_TRUE(plan->ops_by_hash[i].op == NULL);
        guac_mem_free(layer.pending_frame_cells);
        guac_mem_free(previous);
        guac_mem_free(pending);
    }
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_PLAN_ALLOCATIONS], 1);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_PLAN_REUSES], 5);
    display->pending_frame.layers = NULL;
    planner_display_free(display);
}

/** Late flushes cannot allocate or touch cached plans after queue invalidation. */
void test_display__planner_stopped_queue_does_not_allocate() {
    guac_display* display = planner_display_alloc();
    guac_fifo_init(&display->ops, display->ops_items,
            GUAC_DISPLAY_WORKER_FIFO_SIZE, sizeof(guac_display_plan_operation));
    guac_fifo_invalidate(&display->ops);
    guac_display_end_multiple_frames(display, 1);
    CU_ASSERT_TRUE(display->plan_cache == NULL);
    CU_ASSERT_EQUAL(display->planner_statistics[GUAC_DISPLAY_PLANNER_PLAN_ALLOCATIONS], 0);
    guac_fifo_destroy(&display->ops);
    planner_display_free(display);
}

/** Diagnostic shape is fixed, validates arguments, and supports held locks. */
void test_display__planner_statistics_are_numeric_and_locked() {
    guac_display* display = planner_display_alloc();
    uint64_t values[GUAC_DISPLAY_PLANNER_STATISTIC_COUNT];
    CU_ASSERT_EQUAL(guac_display_get_planner_statistics(display, values, 1), 0);
    CU_ASSERT_EQUAL(guac_display_get_planner_statistics(display, NULL, 10), 0);
    guac_rwlock_acquire_write_lock(&display->pending_frame.lock);
    guac_display_plan* plan = PFW_guac_display_plan_alloc(display, 1);
    guac_display_plan_free(plan);
    CU_ASSERT_EQUAL(guac_display_get_planner_statistics(display, values, 10), 1);
    CU_ASSERT_EQUAL(values[GUAC_DISPLAY_PLANNER_PLAN_ALLOCATIONS], 1);
    CU_ASSERT_TRUE(values[GUAC_DISPLAY_PLANNER_RETAINED_BYTES] > 0);
    guac_rwlock_release_lock(&display->pending_frame.lock);
    planner_display_free(display);
}
