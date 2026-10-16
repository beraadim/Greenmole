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

#ifndef BENCHMARK_PNG_COMPRESSION_CONTROL_H
#define BENCHMARK_PNG_COMPRESSION_CONTROL_H

#include <stdint.h>
#include <stdio.h>

/** Benchmark-only indexed-PNG settings. No production API or environment knob.
 * Initialize once before workers/fork: level default/1/3, filter
 * default/none/up/fast, strategy default/rle. Invalid/repeated init returns0.
 * The helper interposes png_write_png and forwards to real libpng, applying
 * settings only to palette images. Link with -ldl and the image's libpng. */
int benchmark_png_control_initialize(const char* level, const char* filter,
        const char* strategy);

typedef struct benchmark_png_statistics {
    uint64_t indexed_calls;
    uint64_t indexed_pixels;
    uint64_t other_calls;
    uint64_t level_applications;
    uint64_t filter_applications;
    uint64_t strategy_applications;
} benchmark_png_statistics;

/** Relaxed numeric counters; callers snapshot only after workers finish. */
benchmark_png_statistics benchmark_png_control_snapshot(void);

/** Thread-local successful hook admissions, for per-image fail-closed coverage. */
uint64_t benchmark_png_control_thread_calls(void);

/** Writes one JSON object for a completed measured interval; no payload data. */
void benchmark_png_control_json(FILE* output,
        const benchmark_png_statistics* start,
        const benchmark_png_statistics* end);

#endif
