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

/* Preparation-only comparison. No PNG compression, protocol or workers run.
 * Build against the candidate's palette source and real Cairo/libguac APIs.
 * Optional source override supports absolute paths within component images. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <stdint.h>
#include <cairo/cairo.h>
#include "palette.h"
#include "guacamole/mem.h"

guac_palette* preparation_palette_alloc(cairo_surface_t* surface);
int preparation_palette_find(guac_palette* palette, int color);
int preparation_palette_prepare(cairo_surface_t* surface, guac_palette** palette,
        png_byte*** rows);
void preparation_palette_free(guac_palette* palette);

static size_t preparation_allocations;
static size_t preparation_bytes;
static void* preparation_alloc(size_t count, const size_t* factors) {
    size_t size;
    if (PRIV_guac_mem_ckd_mul(&size, count, factors))
        return NULL;
    preparation_allocations++;
    preparation_bytes += size;
    return PRIV_guac_mem_alloc(count, factors);
}
static void* preparation_zalloc(size_t count, const size_t* factors) {
    size_t size;
    if (PRIV_guac_mem_ckd_mul(&size, count, factors))
        return NULL;
    preparation_allocations++;
    preparation_bytes += size;
    return PRIV_guac_mem_zalloc(count, factors);
}

#define guac_palette_alloc preparation_palette_alloc
#define guac_palette_find preparation_palette_find
#define guac_palette_prepare preparation_palette_prepare
#define guac_palette_free preparation_palette_free
#define PRIV_guac_mem_alloc preparation_alloc
#define PRIV_guac_mem_zalloc preparation_zalloc
#ifndef GUAC_PNG_PALETTE_SOURCE
#define GUAC_PNG_PALETTE_SOURCE "../../server/src/libguac/palette.c"
#endif
#include GUAC_PNG_PALETTE_SOURCE
#undef PRIV_guac_mem_alloc
#undef PRIV_guac_mem_zalloc
#undef guac_palette_alloc
#undef guac_palette_find
#undef guac_palette_prepare
#undef guac_palette_free

/** Reproduction of private.9's palette hash/build then independent index pass,
 * including its contiguous pointer table and rows. Validated outside timing. */
static int preparation_legacy(cairo_surface_t* surface, guac_palette** output,
        png_byte*** output_rows) {
    int width = cairo_image_surface_get_width(surface);
    int height = cairo_image_surface_get_height(surface);
    int stride = cairo_image_surface_get_stride(surface);
    const unsigned char* data = cairo_image_surface_get_data(surface);
    guac_palette* palette = preparation_zalloc(1, (const size_t[]) { sizeof(*palette) });
    if (palette == NULL)
        abort();
    *output = NULL;
    *output_rows = NULL;
    for (int y = 0; y < height; y++) {
        const uint32_t* row = (const uint32_t*) (data + y * stride);
        for (int x = 0; x < width; x++) {
            int color = row[x] & 0xFFFFFF;
            int hash = ((color & 0xFFF000) >> 12) ^ (color & 0xFFF);
            while (palette->entries[hash].index && palette->entries[hash].color != color)
                hash = (hash + 1) & 0xFFF;
            if (!palette->entries[hash].index) {
                if (palette->size == 256) {
                    guac_mem_free(palette);
                    return 0;
                }
                png_color* c = &palette->colors[palette->size];
                c->red = color >> 16;
                c->green = (color >> 8) & 255;
                c->blue = color & 255;
                palette->entries[hash].color = color;
                palette->entries[hash].index = ++palette->size;
            }
        }
    }
    png_byte** rows = preparation_alloc(2,
            (const size_t[]) { (size_t) width + sizeof(*rows), (size_t) height });
    if (rows == NULL)
        abort();
    png_byte* indices = (png_byte*) (rows + height);
    for (int y = 0; y < height; y++) {
        rows[y] = indices + (size_t) y * width;
        const uint32_t* row = (const uint32_t*) (data + y * stride);
        for (int x = 0; x < width; x++) {
            int color = row[x] & 0xFFFFFF;
            int hash = ((color & 0xFFF000) >> 12) ^ (color & 0xFFF);
            while (palette->entries[hash].color != color)
                hash = (hash + 1) & 0xFFF;
            rows[y][x] = (png_byte) (palette->entries[hash].index - 1);
        }
    }
    *output = palette;
    *output_rows = rows;
    return 1;
}

static double preparation_now(clockid_t clock) {
    struct timespec time;
    if (clock_gettime(clock, &time))
        abort();
    return time.tv_sec * 1000.0 + time.tv_nsec / 1000000.0;
}
static int preparation_compare(const void* a, const void* b) {
    double x = *(const double*) a, y = *(const double*) b;
    return (x > y) - (x < y);
}
static void preparation_validate(cairo_surface_t* surface) {
    guac_palette* actual;
    guac_palette* expected;
    png_byte** actual_rows;
    png_byte** expected_rows;
    int got = preparation_palette_prepare(surface, &actual, &actual_rows);
    int want = preparation_legacy(surface, &expected, &expected_rows);
    if (got != want || got < 0)
        abort();
    if (got) {
        int width = cairo_image_surface_get_width(surface);
        int height = cairo_image_surface_get_height(surface);
        if (actual->size != expected->size
                || memcmp(actual->colors, expected->colors, actual->size * sizeof(png_color)))
            abort();
        for (int y = 0; y < height; y++)
            if (memcmp(actual_rows[y], expected_rows[y], (size_t) width))
                abort();
    }
    guac_mem_free(actual_rows);
    guac_mem_free(expected_rows);
    preparation_palette_free(actual);
    preparation_palette_free(expected);
}

int main(int argc, char** argv) {
    if (argc != 3 || (strcmp(argv[1], "legacy") && strcmp(argv[1], "fused"))) {
        fprintf(stderr, "Usage: %s legacy|fused SAMPLES\n", argv[0]);
        return 2;
    }
    char* end;
    long samples = strtol(argv[2], &end, 10);
    if (*end || samples < 2 || samples > 100000)
        return 2;
    int fused = !strcmp(argv[1], "fused");
    const struct { const char* name; int width, height, pattern; } cases[] = {
        { "small-text-runs", 160, 90, 0 },
        { "grayscale-256", 256, 64, 1 },
        { "old-hash-collisions", 256, 64, 2 },
        { "new-hash-collisions", 256, 64, 3 },
        { "large-palette", 1024, 256, 1 },
        { "tall-narrow-palette", 1, 10000, 1 },
        { "high-color", 1024, 512, 4 },
        { "late-high-color", 256, 128, 5 }
    };
    for (size_t c = 0; c < sizeof(cases) / sizeof(*cases); c++) {
        int width = cases[c].width, height = cases[c].height;
        int stride = (width + 11) * (int) sizeof(uint32_t);
        size_t source_size = (size_t) stride * height;
        unsigned char* data = malloc(source_size);
        unsigned char* snapshot = malloc(source_size);
        double* elapsed = malloc((size_t) samples * sizeof(*elapsed));
        if (!data || !snapshot || !elapsed)
            abort();
        memset(data, 0xCD, source_size);
        uint32_t collisions[256];
        unsigned int found = 0;
        for (uint32_t color = 0; found < 256; color++)
            if (guac_palette_hash((int) color) == 0)
                collisions[found++] = color;
        for (int y = 0; y < height; y++) {
            uint32_t* row = (uint32_t*) (data + y * stride);
            for (int x = 0; x < width; x++) {
                unsigned int position = (unsigned int) (y * width + x);
                unsigned int index = position & 255;
                uint32_t color = cases[c].pattern == 0 ? (position / 16 % 16) * 0x112233U
                    : cases[c].pattern == 2 ? (index << 12) | index
                    : cases[c].pattern == 3 ? collisions[index]
                    : cases[c].pattern == 4 ? position & 0xFFFFFFU
                    : index * 0x010101U;
                if (cases[c].pattern == 5 && y == height - 1 && x == width - 1)
                    color = 0x123456;
                row[x] = color | ((position & 255) << 24);
            }
        }
        memcpy(snapshot, data, source_size);
        cairo_surface_t* surface = cairo_image_surface_create_for_data(data,
                CAIRO_FORMAT_RGB24, width, height, stride);
        if (cairo_surface_status(surface))
            abort();
        preparation_validate(surface);
        size_t allocations = 0, bytes = 0;
        double cpu = 0;
        int result = 0;
        for (long frame = -20; frame < samples; frame++) {
            preparation_allocations = 0;
            preparation_bytes = 0;
            guac_palette* palette;
            png_byte** rows;
            double cpu_started = frame >= 0 ? preparation_now(CLOCK_PROCESS_CPUTIME_ID) : 0;
            double started = frame >= 0 ? preparation_now(CLOCK_MONOTONIC) : 0;
            result = fused ? preparation_palette_prepare(surface, &palette, &rows)
                : preparation_legacy(surface, &palette, &rows);
            if (result < 0)
                abort();
            guac_mem_free(rows);
            preparation_palette_free(palette);
            if (frame >= 0) {
                elapsed[frame] = preparation_now(CLOCK_MONOTONIC) - started;
                cpu += preparation_now(CLOCK_PROCESS_CPUTIME_ID) - cpu_started;
                allocations += preparation_allocations;
                bytes += preparation_bytes;
            }
        }
        if (memcmp(data, snapshot, source_size))
            abort();
        qsort(elapsed, (size_t) samples, sizeof(*elapsed), preparation_compare);
        double p50 = elapsed[(samples - 1) / 2], p95 = elapsed[(samples - 1) * 95 / 100];
        if (!isfinite(p50) || !isfinite(p95) || !isfinite(cpu)
                || p50 <= 0 || p95 <= 0 || cpu <= 0)
            abort();
        printf("{\"scenario\":\"%s\",\"mode\":\"%s\",\"samples\":%ld,\"warmup\":20,"
                "\"width\":%d,\"height\":%d,\"indexed\":%s,\"prepare_free_p50_ms\":%.6f,"
                "\"prepare_free_p95_ms\":%.6f,\"cpu_ms_per_call\":%.6f,"
                "\"allocations_per_call\":%.2f,\"allocated_bytes_per_call\":%.2f,"
                "\"source_unchanged\":true}\n", cases[c].name, argv[1], samples,
                width, height, result ? "true" : "false", p50, p95, cpu / samples,
                (double) allocations / samples, (double) bytes / samples);
        free(elapsed);
        cairo_surface_destroy(surface);
        free(snapshot);
        free(data);
    }
    return 0;
}
