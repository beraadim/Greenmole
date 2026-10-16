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

#include "png-compression-control.h"

#include <dlfcn.h>
#include <inttypes.h>
#include <png.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

static void (*real_png_write_png)(png_structrp, png_inforp, int, png_voidp);
static int initialized;
static int selected_level = -1, selected_filter = -1, selected_strategy = -1;
static const char* level_name;
static const char* filter_name;
static const char* strategy_name;
static _Atomic uint64_t indexed_calls, indexed_pixels, other_calls;
static _Atomic uint64_t level_applications, filter_applications, strategy_applications;
static _Thread_local uint64_t thread_calls;

int benchmark_png_control_initialize(const char* level, const char* filter,
        const char* strategy) {
    if (initialized || !level || !filter || !strategy)
        return 0;
    int level_value = -1, filter_value = -1, strategy_value = -1;
    if (!strcmp(level, "1")) level_value = 1;
    else if (!strcmp(level, "3")) level_value = 3;
    else if (strcmp(level, "default")) return 0;
    if (!strcmp(filter, "none")) filter_value = PNG_FILTER_NONE;
    else if (!strcmp(filter, "up")) filter_value = PNG_FILTER_UP;
    else if (!strcmp(filter, "fast")) filter_value = PNG_FAST_FILTERS;
    else if (strcmp(filter, "default")) return 0;
    if (!strcmp(strategy, "rle")) strategy_value = Z_RLE;
    else if (strcmp(strategy, "default")) return 0;
    union {
        void* pointer;
        void (*function)(png_structrp, png_inforp, int, png_voidp);
    } symbol;
    symbol.pointer = dlsym(RTLD_NEXT, "png_write_png");
    if (!symbol.pointer)
        return 0;
    real_png_write_png = symbol.function;
    selected_level = level_value;
    selected_filter = filter_value;
    selected_strategy = strategy_value;
    level_name = level_value < 0 ? "default" : level_value == 1 ? "1" : "3";
    filter_name = filter_value < 0 ? "default" : filter_value == PNG_FILTER_NONE
        ? "none" : filter_value == PNG_FILTER_UP ? "up" : "fast";
    strategy_name = strategy_value < 0 ? "default" : "rle";
    initialized = 1;
    return 1;
}

void png_write_png(png_structrp png, png_inforp info, int transforms,
        png_voidp parameters) {
    if (!initialized) {
        fprintf(stderr, "PNG benchmark control was not initialized.\n");
        exit(1);
    }
    if (png_get_color_type(png, info) == PNG_COLOR_TYPE_PALETTE) {
        if (selected_level >= 0) {
            png_set_compression_level(png, selected_level);
            atomic_fetch_add_explicit(&level_applications, 1, memory_order_relaxed);
        }
        if (selected_filter >= 0) {
            png_set_filter(png, PNG_FILTER_TYPE_BASE, selected_filter);
            atomic_fetch_add_explicit(&filter_applications, 1, memory_order_relaxed);
        }
        if (selected_strategy >= 0) {
            png_set_compression_strategy(png, selected_strategy);
            atomic_fetch_add_explicit(&strategy_applications, 1, memory_order_relaxed);
        }
        atomic_fetch_add_explicit(&indexed_pixels,
                (uint64_t) png_get_image_width(png, info) * png_get_image_height(png, info),
                memory_order_relaxed);
        atomic_fetch_add_explicit(&indexed_calls, 1, memory_order_relaxed);
        thread_calls++;
    }
    else
        atomic_fetch_add_explicit(&other_calls, 1, memory_order_relaxed);
    real_png_write_png(png, info, transforms, parameters);
}

benchmark_png_statistics benchmark_png_control_snapshot(void) {
    benchmark_png_statistics result = {
        atomic_load_explicit(&indexed_calls, memory_order_relaxed),
        atomic_load_explicit(&indexed_pixels, memory_order_relaxed),
        atomic_load_explicit(&other_calls, memory_order_relaxed),
        atomic_load_explicit(&level_applications, memory_order_relaxed),
        atomic_load_explicit(&filter_applications, memory_order_relaxed),
        atomic_load_explicit(&strategy_applications, memory_order_relaxed)
    };
    return result;
}

uint64_t benchmark_png_control_thread_calls(void) {
    return thread_calls;
}

void benchmark_png_control_json(FILE* output,
        const benchmark_png_statistics* start,
        const benchmark_png_statistics* end) {
    uint64_t calls = end->indexed_calls - start->indexed_calls;
    uint64_t pixels = end->indexed_pixels - start->indexed_pixels;
    uint64_t other = end->other_calls - start->other_calls;
    uint64_t levels = end->level_applications - start->level_applications;
    uint64_t filters = end->filter_applications - start->filter_applications;
    uint64_t strategies = end->strategy_applications - start->strategy_applications;
    if (!initialized || (selected_level >= 0 ? levels != calls : levels != 0)
            || (selected_filter >= 0 ? filters != calls : filters != 0)
            || (selected_strategy >= 0 ? strategies != calls : strategies != 0)) {
        fprintf(stderr, "PNG benchmark settings were not applied consistently.\n");
        exit(1);
    }
    fprintf(output, "{\"level\":\"%s\",\"filter\":\"%s\",\"strategy\":\"%s\","
            "\"indexed_calls\":%" PRIu64 ",\"indexed_pixels\":%" PRIu64 ",\"other_calls\":%" PRIu64
            ",\"level_applications\":%" PRIu64 ",\"filter_applications\":%" PRIu64
            ",\"strategy_applications\":%" PRIu64 ",\"hooks_verified\":true}",
            level_name, filter_name, strategy_name, calls, pixels, other, levels, filters, strategies);
}
