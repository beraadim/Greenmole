/*
 * Modified for Greenmole by its maintainers.
 *
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
#include "guacamole/display.h"
#include "guacamole/rect.h"

#include <string.h>
#include <stdint.h>

/**
 * Stores the given operation within the ops_by_hash table of the given display
 * plan based on the given hash value. The hash function applied for storing
 * the operation is GUAC_DISPLAY_PLAN_OPERATION_HASH(). If another operation is
 * already stored at the same location within ops_by_hash, it is preserved and
 * the new operation is not indexed.
 *
 * @param plan
 *     The plan to store the operation within.
 *
 * @param hash
 *     The hash value to use to calculate the storage location. This value will
 *     be further hashed with GUAC_DISPLAY_PLAN_OPERATION_HASH().
 *
 * @param op
 *     The operation to store.
 */
static void guac_display_plan_store_indexed_op(guac_display_plan* plan, uint64_t hash,
        guac_display_plan_operation* op) {

    size_t index = GUAC_DISPLAY_PLAN_OPERATION_HASH(hash);
    guac_display_plan_indexed_operation* entry = &(plan->ops_by_hash[index]);

    if (entry->op == NULL) {
        GUAC_ASSERT(plan->touched_count < GUAC_DISPLAY_PLAN_OPERATION_INDEX_SIZE);
        plan->touched_indices[plan->touched_count++] = index;
        entry->hash = hash;
        entry->op = op;
        plan->occupied_buckets[index / 64] |= UINT64_C(1) << (index % 64);
        plan->indexed_count++;
        plan->display->planner_statistics[GUAC_DISPLAY_PLANNER_CANDIDATES_INDEXED]++;
    }

}

/**
 * Removes and returns a pointer to the matching operation stored within the
 * ops_by_hash table of the given display plan, if any. If no such operation is
 * stored, NULL is returned.
 *
 * @param plan
 *     The plan to retrieve the operation from.
 *
 * @param hash
 *     The hash value to use to calculate the storage location. This value will
 *     be further hashed with GUAC_DISPLAY_PLAN_OPERATION_HASH().
 *
 * @return
 *     The operation that was stored under the given hash, if any, or NULL if
 *     no such operation was found.
 */
static guac_display_plan_operation* guac_display_plan_remove_indexed_op(guac_display_plan* plan, uint64_t hash) {

    size_t index = GUAC_DISPLAY_PLAN_OPERATION_HASH(hash);
    uint64_t* occupied = &plan->occupied_buckets[index / 64];
    uint64_t mask = UINT64_C(1) << (index % 64);

    /* Most rolling windows miss. Reject empty buckets using the compact
     * bitmap before reading the 1 MiB operation index. This is exact bucket
     * membership; full-hash and pixel comparisons below remain necessary. */
    if (!(*occupied & mask))
        return NULL;

    guac_display_plan_indexed_operation* entry = &(plan->ops_by_hash[index]);

    /* NOTE: We verify the hash value here because the lookup performed is
     * actually a hash of a hash. There's an additional chance of collisions
     * between hash values at this second level of hashing. */

    guac_display_plan_operation* op = entry->op;
    if (op != NULL && entry->hash == hash) {
        entry->op = NULL;
        *occupied &= ~mask;
        GUAC_ASSERT(plan->indexed_count > 0);
        plan->indexed_count--;
        return op;
    }

    return NULL;

}

/**
 * Hashes one row using the unsigned base-62 polynomial used by copy search.
 * Four independent chains reduce the serial multiply/add dependency, with
 * 62^4 as the base. Recombining the chains and appending the final zero to
 * three pixels is exactly equivalent to ordinary Horner evaluation, including
 * all modulo-2^64 wraparound. Callers use fixed lengths of 63 or 64 pixels.
 */
static inline uint64_t guac_hash_row(const uint32_t* row, int length) {

    uint64_t a = 0, b = 0, c = 0, d = 0;
    int grouped = length & ~3;
    for (int x = 0; x < grouped; x += 4) {
        a = a * UINT64_C(14776336) + row[x];
        b = b * UINT64_C(14776336) + row[x + 1];
        c = c * UINT64_C(14776336) + row[x + 2];
        d = d * UINT64_C(14776336) + row[x + 3];
    }

    uint64_t hash = ((a * 62 + b) * 62 + c) * 62 + d;
    for (int x = grouped; x < length; x++)
        hash = hash * 62 + row[x];
    return hash;

}

/**
 * Hashes one complete 64x64 cell. This is the same polynomial as the final
 * window of the rolling search, but needs only scalar accumulators. Indexing
 * a single cell does not clear the full-width rolling-hash array.
 * The caller must constrain the cell to a complete in-bounds 64x64 rectangle.
 */
static uint64_t guac_hash_cell(const guac_display_layer_state* layer_state,
        const guac_rect* cell) {
    const unsigned char* data = GUAC_DISPLAY_LAYER_STATE_CONST_BUFFER(*layer_state, *cell);
    uint64_t cell_hash = 0;
    for (int y = 0; y < GUAC_DISPLAY_CELL_SIZE; y++) {
        const uint32_t* row = (const uint32_t*) data;
        uint64_t row_hash = guac_hash_row(row, GUAC_DISPLAY_CELL_SIZE);
        cell_hash = ((cell_hash * 31) << 1) + row_hash;
        if (y + 1 < GUAC_DISPLAY_CELL_SIZE)
            data += layer_state->buffer_stride;
    }
    return cell_hash;
}

static void PFR_LFR_guac_display_plan_find_copies(guac_display_plan* plan,
        int x, int y, uint64_t hash, guac_display_layer* copy_from_layer);

/**
 * Searches each 64x64 window of the given layer's committed image for indexed
 * candidates. Windows are visited in the original row-major order. A candidate
 * exhaustion check after each row keeps the stop condition out of the per-pixel
 * rolling-hash loop. Returns the number of complete windows examined.
 */
static size_t PFR_LFR_guac_display_plan_search_layer(guac_display_plan* plan,
        guac_display_layer* layer, const guac_rect* rect) {

    const guac_display_layer_state* layer_state = &layer->last_frame;

    /* A smaller region cannot contain a complete hash window. */
    if (guac_rect_width(rect) < GUAC_DISPLAY_CELL_SIZE
            || guac_rect_height(rect) < GUAC_DISPLAY_CELL_SIZE)
        return 0;

    size_t stride = layer_state->buffer_stride;
    const unsigned char* data = GUAC_DISPLAY_LAYER_STATE_CONST_BUFFER(*layer_state, *rect);

    const int prefix = GUAC_DISPLAY_CELL_SIZE - 1;
    const int windows_per_row = guac_rect_width(rect) - prefix;
    const int window_rows = guac_rect_height(rect) - prefix;
    uint64_t cell_hash[GUAC_DISPLAY_MAX_WIDTH];
    memset(cell_hash, 0, (size_t) windows_per_row * sizeof(uint64_t));

    /* The first 63 rows cannot form a complete window. The first 63 columns
     * of every row contribute to its row hash, but never need a vertical
     * accumulator. Keep both warm-up regions out of the lookup loop. */
    for (int y = 0; y < prefix; y++) {
        const uint32_t* row = (const uint32_t*) data;
        uint64_t row_hash = guac_hash_row(row, prefix);
        row += prefix;
        for (int x = 0; x < windows_per_row; x++) {
            row_hash = row_hash * 62 + row[x];
            cell_hash[x] = cell_hash[x] * 62 + row_hash;
        }
        data += stride;
    }

    for (int y = 0; y < window_rows; y++) {
        const uint32_t* row = (const uint32_t*) data;
        uint64_t row_hash = guac_hash_row(row, prefix);
        row += prefix;
        for (int x = 0; x < windows_per_row; x++) {
            row_hash = row_hash * 62 + row[x];
            uint64_t hash = cell_hash[x] * 62 + row_hash;
            cell_hash[x] = hash;
            PFR_LFR_guac_display_plan_find_copies(plan,
                    rect->left + x, rect->top + y, hash, layer);
        }

        /* Empty buckets cannot produce more copies. Finish this row before
         * stopping so misses do not pay an extra branch for every window. */
        if (plan->indexed_count == 0)
            return (size_t) (y + 1) * windows_per_row;

        if (y + 1 < window_rows)
            data += stride;

    } /* end for each row */

    return (size_t) window_rows * windows_per_row;

}

/**
 * Initializes the given rectangle with the bounds of the pending frame cell
 * containing the given coordinate.
 *
 * @param rect
 *     The rectangle to initialize.
 *
 * @param x
 *     The X coordinate of the point that the rectangle must contain.
 *
 * @param y
 *     The Y coordinate of the point that the rectangle must contain.
 */
static void guac_display_cell_init_rect(guac_rect* rect, int x, int y) {
    x = (x / GUAC_DISPLAY_CELL_SIZE) * GUAC_DISPLAY_CELL_SIZE;
    y = (y / GUAC_DISPLAY_CELL_SIZE) * GUAC_DISPLAY_CELL_SIZE;
    guac_rect_init(rect, x, y, GUAC_DISPLAY_CELL_SIZE, GUAC_DISPLAY_CELL_SIZE);
}

void PFR_guac_display_plan_index_dirty_cells(guac_display_plan* plan) {

    guac_display_plan_reset_index(plan);

    guac_display_plan_operation* op = plan->ops;
    for (int i = 0; i < plan->length; i++) {

        if (op->type == GUAC_DISPLAY_PLAN_OPERATION_IMG) {

            guac_display_layer* layer = op->layer;

            guac_rect layer_bounds;
            guac_display_layer_get_bounds(layer, &layer_bounds);

            guac_rect cell;
            guac_display_cell_init_rect(&cell, op->dest.left, op->dest.top);

            guac_rect_constrain(&cell, &layer_bounds);
            if (guac_rect_width(&cell) == GUAC_DISPLAY_CELL_SIZE
                    && guac_rect_height(&cell) == GUAC_DISPLAY_CELL_SIZE) {
                guac_display_plan_store_indexed_op(plan,
                        guac_hash_cell(&layer->pending_frame, &cell), op);
            }

        }

        op++;

    }

}

/**
 * Compares two rectangular regions of two arbitrary buffers, returning whether
 * those regions contain identical data.
 *
 * @param data_a
 *     A pointer to the first byte of image data within the first region being
 *     compared.
 *
 * @param width_a
 *     The width of the first region, in pixels.
 *
 * @param height_a
 *     The height of the first region, in pixels.
 *
 * @param stride_a
 *     The number of bytes in each row of image data in the first region.
 *
 * @param data_b
 *     A pointer to the first byte of image data within the second region being
 *     compared.
 *
 * @param width_b
 *     The width of the second region, in pixels.
 *
 * @param height_b
 *     The height of the second region, in pixels.
 *
 * @param stride_b
 *     The number of bytes in each row of image data in the first region.
 *
 * @return
 *     Non-zero if the regions contain at least one differing pixel, zero
 *     otherwise.
 */
static int guac_image_cmp(const unsigned char* restrict data_a, int width_a, int height_a,
        int stride_a, const unsigned char* restrict data_b, int width_b, int height_b,
        int stride_b) {

    int y;

    /* If core dimensions differ, just compare those. Done. */
    if (width_a != width_b) return width_a - width_b;
    if (height_a != height_b) return height_a - height_b;

    size_t length = guac_mem_ckd_mul_or_die(width_a, GUAC_DISPLAY_LAYER_RAW_BPP);

    for (y = 0; y < height_a; y++) {

        /* Compare row. If different, use that result. */
        int cmp_result = memcmp(data_a, data_b, length);
        if (cmp_result != 0)
            return cmp_result;

        /* Do not form pointers beyond a bottom-reaching subregion after its
         * final comparison. Its left offset need not exist in the next row. */
        if (y + 1 < height_a) {
            data_a += stride_a;
            data_b += stride_b;
        }

    }

    /* Otherwise, same. */
    return 0;

}

/**
 * Searches the ops_by_hash table of the given display plan for occurrences of
 * the given hash, replacing
 * the matching operation with a copy operation if a match is found.
 *
 * NOTE: While this function will search for and optimize operations that copy
 * existing data, it can only do so for distinct image data. Multiple
 * operations that copy the same exact data (like a region tiled with multiple
 * copies of some pattern) can only be stored in the table once, and therefore
 * will only match once.
 *
 * @param plan
 *     The display plan to update with any copies found.
 *
 * @param x
 *     The X coordinate of the upper-left corner of the 64x64 region currently
 *     being checked.
 *
 * @param y
 *     The Y coordinate of the upper-left corner of the 64x64 region currently
 *     being checked.
 *
 * @param hash
 *     The hash value that applies to the 64x64 rectangle at the given
 *     coordinates.
 *
 * @param copy_from_layer
 *     The layer that is being searched.
 */
static void PFR_LFR_guac_display_plan_find_copies(guac_display_plan* plan,
        int x, int y, uint64_t hash, guac_display_layer* copy_from_layer) {

    /* Transform the matching operation into a copy of the current region if
     * any operations match, banning the underlying hash from further checks if
     * a collision occurs */
    guac_display_plan_operation* op = guac_display_plan_remove_indexed_op(plan, hash);
    if (op != NULL) {

        guac_display_layer* copy_to_layer = op->layer;

        guac_rect src_rect;
        guac_rect_init(&src_rect, x, y, GUAC_DISPLAY_CELL_SIZE, GUAC_DISPLAY_CELL_SIZE);

        guac_rect dst_rect;
        guac_display_cell_init_rect(&dst_rect, op->dest.left, op->dest.top);

        const unsigned char* copy_from = GUAC_DISPLAY_LAYER_STATE_CONST_BUFFER(copy_from_layer->last_frame, src_rect);
        const unsigned char* copy_to = GUAC_DISPLAY_LAYER_STATE_CONST_BUFFER(copy_to_layer->pending_frame, dst_rect);

        /* Only transform into a copy if the image data is truly identical (not a collision) */
        if (!guac_image_cmp(copy_from, GUAC_DISPLAY_CELL_SIZE, GUAC_DISPLAY_CELL_SIZE, copy_from_layer->last_frame.buffer_stride,
                copy_to, GUAC_DISPLAY_CELL_SIZE, GUAC_DISPLAY_CELL_SIZE, copy_to_layer->pending_frame.buffer_stride)) {
            op->type = GUAC_DISPLAY_PLAN_OPERATION_COPY;
            op->src.layer_rect.layer = copy_from_layer->last_frame_buffer;
            op->src.layer_rect.rect = src_rect;
            op->dest = dst_rect;
            plan->display->planner_statistics[GUAC_DISPLAY_PLANNER_COPY_MATCHES]++;
        }

    }

}

void PFR_LFR_guac_display_plan_rewrite_as_copies(guac_display_plan* plan) {

    guac_display* display = plan->display;
    if (plan->indexed_count == 0) {
        display->planner_statistics[GUAC_DISPLAY_PLANNER_EMPTY_SEARCHES]++;
        return;
    }
    guac_display_layer* current = display->last_frame.layers;
    while (current != NULL) {

        /* Search only the layers that are specifically noted as possible
         * sources for copies */
        if (current->pending_frame.search_for_copies) {

            guac_rect search_region;
            guac_rect_init(&search_region, 0, 0, current->last_frame.width, current->last_frame.height);

            /* Avoid excessive computation by restricting the search region to only
             * the area that was changed in the upcoming frame (in the case of
             * scrolling, absolutely all data relevant to the scroll will have been
             * modified) */
            guac_rect_constrain(&search_region, &current->pending_frame.dirty);

            display->planner_statistics[GUAC_DISPLAY_PLANNER_SEARCH_WINDOWS]
                += PFR_LFR_guac_display_plan_search_layer(plan, current, &search_region);
            if (plan->indexed_count == 0) {
                display->planner_statistics[GUAC_DISPLAY_PLANNER_EXHAUSTED_SEARCHES]++;
                break;
            }
        }

        current = current->last_frame.next;

    }

}
