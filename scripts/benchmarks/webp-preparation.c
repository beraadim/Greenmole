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

/* Standalone preparation-only comparison. The current production helper is
 * compiled here; legacy allocation/copy is reproduced below. No WebPEncode,
 * protocol output, worker queue, capture, or browser timing is measured. */
#include <webp/encode.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t preparation_growth, preparation_transient;
static void* preparation_realloc(void* data, size_t size) {
    preparation_growth++;
    return realloc(data, size);
}
static int preparation_picture_alloc(WebPPicture* picture) {
    preparation_transient++;
    return WebPPictureAlloc(picture);
}

/* The parent orchestrator may override this path inside a component image. */
#ifndef GUAC_WEBP_PREPARATION_SOURCE
#define GUAC_WEBP_PREPARATION_SOURCE "../../server/src/libguac/encode-webp.c"
#endif
#define guac_webp_write preparation_unused_webp_write
#define guac_webp_set_workspace preparation_set_workspace
#define guac_webp_workspace_free preparation_workspace_free
#define realloc preparation_realloc
#define WebPPictureAlloc preparation_picture_alloc
#include GUAC_WEBP_PREPARATION_SOURCE
#undef WebPPictureAlloc
#undef realloc
#undef guac_webp_workspace_free
#undef guac_webp_set_workspace
#undef guac_webp_write

static double preparation_now(clockid_t id) {
    struct timespec value;
    if (clock_gettime(id, &value)) { perror("clock_gettime"); exit(1); }
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

/* Match private.8's initialization, allocation and per-pixel preparation. */
static int preparation_legacy(WebPPicture* picture, cairo_surface_t* surface) {
    int width = cairo_image_surface_get_width(surface);
    int height = cairo_image_surface_get_height(surface);
    int stride = cairo_image_surface_get_stride(surface);
    cairo_format_t format = cairo_image_surface_get_format(surface);
    const unsigned char* data = cairo_image_surface_get_data(surface);
    picture->use_argb = 1; picture->width = width; picture->height = height;
    if (!preparation_picture_alloc(picture)) return 0;
    uint32_t* output = picture->argb;
    for (int y = 0; y < height; y++) {
        const uint32_t* row = (const uint32_t*) data;
        for (int x = 0; x < width; x++) {
            uint32_t pixel = row[x];
            if (format != CAIRO_FORMAT_ARGB32) pixel |= UINT32_C(0xFF000000);
            output[x] = pixel;
        }
        if (y + 1 < height) {
            data += stride;
            output += picture->argb_stride;
        }
    }
    return 1;
}

static int preparation_compare(const void* left, const void* right) {
    double a = *(const double*) left, b = *(const double*) right;
    return (a > b) - (a < b);
}

static int preparation_case(const char* name, int width, int height, int argb,
        int reuse, int count) {
    int stride = (width + 11) * 4;
    size_t size = (size_t) stride * height;
    unsigned char* data = malloc(size);
    unsigned char* before = malloc(size);
    double* elapsed = malloc((size_t) count * sizeof(double));
    if (!data || !before || !elapsed) return 1;
    memset(data, 0xA5, size);
    for (int y = 0; y < height; y++) {
        uint32_t* row = (uint32_t*) (data + (size_t) y * stride);
        for (int x = 0; x < width; x++) row[x] = (uint32_t) x * 2654435761U + (uint32_t) y * 2246822519U;
    }
    memcpy(before, data, size);
    cairo_surface_t* surface = cairo_image_surface_create_for_data(data,
            argb ? CAIRO_FORMAT_ARGB32 : CAIRO_FORMAT_RGB24, width, height, stride);
    if (cairo_surface_status(surface)) return 1;
    guac_webp_workspace workspace = { 0 };
    /* Validate before taking any timed samples. The normal library free call
     * still sees every prepared picture below, keeping its input observable. */
    WebPPicture checked;
    if (!WebPPictureInit(&checked)) return 1;
    guac_webp_workspace* checked_acquired = NULL;
    if (reuse ? !guac_webp_prepare_picture(&checked, surface, &workspace, &checked_acquired)
            : !preparation_legacy(&checked, surface)) return 1;
    for (int y = 0; y < height; y++) {
        const uint32_t* row = (const uint32_t*) (data + (size_t) y * stride);
        for (int x = 0; x < width; x++)
            if (checked.argb[(size_t) y * checked.argb_stride + x]
                    != (row[x] | (argb ? 0U : UINT32_C(0xFF000000)))) return 1;
    }
    WebPPictureFree(&checked);
    if (checked_acquired) checked_acquired->in_use = 0;
    uint64_t growth_start = 0, transient_start = 0, cached = 0;
    double cpu = 0;
    for (int i = -20; i < count; i++) {
        if (i == 0) { growth_start = preparation_growth; transient_start = preparation_transient; }
        double cpu_start = preparation_now(CLOCK_PROCESS_CPUTIME_ID);
        double started = preparation_now(CLOCK_MONOTONIC);
        WebPPicture picture;
        if (!WebPPictureInit(&picture)) return 1;
        guac_webp_workspace* acquired = NULL;
        if (reuse ? !guac_webp_prepare_picture(&picture, surface, &workspace, &acquired)
                : !preparation_legacy(&picture, surface)) return 1;
        WebPPictureFree(&picture);
        if (acquired) acquired->in_use = 0;
        if (i >= 0) {
            elapsed[i] = preparation_now(CLOCK_MONOTONIC) - started;
            cpu += preparation_now(CLOCK_PROCESS_CPUTIME_ID) - cpu_start;
            cached += acquired != NULL;
        }
    }
    if (memcmp(before, data, size)) return 1;
    qsort(elapsed, (size_t) count, sizeof(double), preparation_compare);
    double p50 = elapsed[(count * 50 + 99) / 100 - 1];
    double p95 = elapsed[(count * 95 + 99) / 100 - 1];
    printf("{\"scenario\":\"%s\",\"mode\":\"%s\",\"samples\":%i,\"warmup\":20,"
            "\"width\":%i,\"height\":%i,\"stride_bytes\":%i,\"format\":\"%s\","
            "\"preparation_free_p50_ms\":%.6f,\"preparation_free_p95_ms\":%.6f,\"cpu_ms_per_call\":%.6f,"
            "\"measured_workspace_growth\":%llu,\"measured_transient_allocations\":%llu,"
            "\"measured_cached_calls\":%llu,\"retained_argb_bytes\":%zu,\"source_unchanged\":true}\n",
            name, reuse ? "workspace" : "legacy", count, width, height, stride, argb ? "argb32" : "rgb24",
            p50, p95, cpu / count,
            (unsigned long long) (preparation_growth - growth_start),
            (unsigned long long) (preparation_transient - transient_start), (unsigned long long) cached,
            workspace.capacity_pixels * sizeof(uint32_t));
    preparation_workspace_free(&workspace);
    cairo_surface_destroy(surface); free(data); free(before); free(elapsed);
    return 0;
}

int main(int argc, char** argv) {
    if (argc != 3 || (strcmp(argv[1], "legacy") && strcmp(argv[1], "workspace"))) return 1;
    char* end;
    long count = strtol(argv[2], &end, 10);
    if (*end || end == argv[2] || count < 2 || count > 100000) return 1;
    int reuse = !strcmp(argv[1], "workspace");
    return preparation_case("small-rgb", 160, 90, 0, reuse, (int) count)
        || preparation_case("tile-rgb", 512, 512, 0, reuse, (int) count)
        || preparation_case("tile-argb", 512, 512, 1, reuse, (int) count)
        || preparation_case("photo-tile-768x432", 768, 432, 0, reuse, (int) count)
        || preparation_case("tile-513x512", 513, 512, 0, reuse, (int) count)
        || preparation_case("observed-max-960x512", 960, 512, 0, reuse, (int) count)
        || preparation_case("oversized-1025x512", 1025, 512, 0, reuse, (int) count);
}
