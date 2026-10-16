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

#include "guacamole/mem.h"
#include "guacamole/error.h"
#include "palette.h"

#include <cairo/cairo.h>

#include <stdint.h>
#include <string.h>

/** Indices held without heap allocation while rejecting high-color images. */
#define GUAC_PALETTE_INDEX_PREFIX_SIZE 4096

/** Mix all RGB bits before reducing to the 4096-bucket map. The former XOR of
 * the two 12-bit halves clustered common grayscale colors into 16 buckets. */
static unsigned int guac_palette_hash(int color) {
    return ((uint32_t) color * UINT32_C(2654435761)) >> 20;
}

/** Finds an existing color or its empty insertion slot. Only collisions need
 * the secondary hash. Its odd stride visits every bucket in this power-of-two
 * table; at most 256 occupied entries means at most 257 probes before a match
 * or empty slot. Equal initial hashes do not form one linear cluster. */
static guac_palette_entry* guac_palette_lookup(guac_palette* palette, int color) {
    unsigned int hash = guac_palette_hash(color);
    guac_palette_entry* entry = &palette->entries[hash];
    if (entry->index != 0 && entry->color != color) {
        unsigned int step = ((unsigned int) color << 1) | 1;
        do {
            hash = (hash + step) & 0xFFF;
            entry = &palette->entries[hash];
        } while (entry->index != 0 && entry->color != color);
    }
    return entry;
}

/** Returns the existing or newly inserted row-major index, or -1 at capacity. */
static int guac_palette_find_or_add(guac_palette* palette, int color) {
    guac_palette_entry* entry = guac_palette_lookup(palette, color);
    if (entry->index == 0) {
        if (palette->size == 256)
            return -1;
        png_color* c = &palette->colors[palette->size];
        c->blue = color & 0xFF;
        c->green = (color >> 8) & 0xFF;
        c->red = (color >> 16) & 0xFF;
        entry->color = color;
        entry->index = ++palette->size;
    }
    return entry->index - 1;
}

/** Repeated source colors need no map probe, including runs crossing rows. */
static int guac_palette_next_index(guac_palette* palette, int color,
        int* last_color, int* last_index) {
    if (color != *last_color) {
        *last_index = guac_palette_find_or_add(palette, color);
        *last_color = color;
    }
    return *last_index;
}

/** Scans one consecutive range of source pixels. Staging decisions are made
 * once per row/chunk, never for each pixel in a text run. The optional output
 * is tightly packed regardless of positive/negative source stride. */
static int guac_palette_scan(guac_palette* palette, cairo_surface_t* surface,
        size_t start, size_t count, png_byte* indices) {
    if (count == 0)
        return 1;
    int width = cairo_image_surface_get_width(surface);
    int stride = cairo_image_surface_get_stride(surface);
    const unsigned char* data = cairo_image_surface_get_data(surface)
        + (ptrdiff_t) (start / width) * stride;
    int x = (int) (start % width);
    int last_color = -1, last_index = 0;
    while (count != 0) {
        size_t length = (size_t) width - x;
        if (length > count)
            length = count;
        const uint32_t* source = (const uint32_t*) data + x;
        if (indices != NULL) {
            for (size_t i = 0; i < length; i++) {
                int index = guac_palette_next_index(palette, source[i] & 0xFFFFFF,
                        &last_color, &last_index);
                if (index < 0)
                    return 0;
                *(indices++) = (png_byte) index;
            }
        }
        else {
            for (size_t i = 0; i < length; i++) {
                if (guac_palette_next_index(palette, source[i] & 0xFFFFFF,
                            &last_color, &last_index) < 0)
                    return 0;
            }
        }
        count -= length;
        if (count != 0)
            data += stride;
        x = 0;
    }
    return 1;
}

/** Allocates the same aligned pointer table plus byte indices as the writer. */
static png_byte** guac_palette_alloc_rows(int width, int height) {
    size_t row_size;
    if (guac_mem_ckd_add(&row_size, sizeof(png_byte*), (size_t) width)) {
        guac_error = GUAC_STATUS_NO_MEMORY;
        guac_error_message = "PNG row storage size overflow";
        return NULL;
    }
    png_byte** rows = (png_byte**) guac_mem_alloc(row_size, (size_t) height);
    if (rows != NULL) {
        png_byte* row = (png_byte*) (rows + height);
        for (int y = 0; y < height; y++) {
            rows[y] = row;
            row += width;
        }
    }
    return rows;
}

/** Builds a palette, optionally preparing all libpng row data. Speculation is
 * limited to 64 KiB including the pointer table, never the full large image.
 * A failed speculative allocation completes palette preflight and retries the
 * ordinary allocation only if indexed encoding remains possible. */
static int guac_palette_prepare_internal(cairo_surface_t* surface,
        guac_palette** result_palette, png_byte*** result_rows) {
    *result_palette = NULL;
    if (result_rows != NULL)
        *result_rows = NULL;
    int width = cairo_image_surface_get_width(surface);
    int height = cairo_image_surface_get_height(surface);
    size_t pixels;
    if (width <= 0 || height <= 0 || cairo_image_surface_get_data(surface) == NULL
            || guac_mem_ckd_mul(&pixels, (size_t) width, (size_t) height))
        return 0;

    guac_palette* palette = (guac_palette*) guac_mem_zalloc(sizeof(guac_palette));
    if (palette == NULL)
        return 0;

    size_t row_size, total_size;
    int fused = result_rows != NULL
        && !guac_mem_ckd_add(&row_size, sizeof(png_byte*), (size_t) width)
        && !guac_mem_ckd_mul(&total_size, row_size, (size_t) height)
        && total_size <= GUAC_PALETTE_INDEX_MAX_BYTES;
    png_byte prefix[GUAC_PALETTE_INDEX_PREFIX_SIZE];
    png_byte** rows = NULL;
    size_t position = fused && pixels > sizeof(prefix) ? sizeof(prefix) : pixels;
    if (!guac_palette_scan(palette, surface, 0, position, fused ? prefix : NULL)) {
        guac_palette_free(palette);
        return 0;
    }
    if (fused && position < pixels) {
        rows = guac_palette_alloc_rows(width, height);
        if (rows != NULL)
            memcpy((png_byte*) (rows + height), prefix, position);
        else
            fused = 0;
        if (!guac_palette_scan(palette, surface, position, pixels - position,
                    rows ? (png_byte*) (rows + height) + position : NULL)) {
            guac_mem_free(rows);
            guac_palette_free(palette);
            return 0;
        }
    }

    if (result_rows != NULL) {
        if (rows == NULL) {
            rows = guac_palette_alloc_rows(width, height);
            if (rows == NULL) {
                guac_palette_free(palette);
                return -1;
            }
            if (fused)
                memcpy((png_byte*) (rows + height), prefix, position);
            else {
                const unsigned char* data = cairo_image_surface_get_data(surface);
                int stride = cairo_image_surface_get_stride(surface);
                int last_color = -1, last_index = 0;
                for (int y = 0; y < height; y++) {
                    const uint32_t* source = (const uint32_t*) data;
                    for (int x = 0; x < width; x++) {
                        int color = source[x] & 0xFFFFFF;
                        if (color != last_color) {
                            last_index = guac_palette_find(palette, color);
                            last_color = color;
                        }
                        rows[y][x] = (png_byte) last_index;
                    }
                    if (y + 1 < height)
                        data += stride;
                }
            }
        }
        *result_rows = rows;
    }
    *result_palette = palette;
    return 1;
}

int guac_palette_prepare(cairo_surface_t* surface, guac_palette** palette,
        png_byte*** rows) {
    return guac_palette_prepare_internal(surface, palette, rows);
}

guac_palette* guac_palette_alloc(cairo_surface_t* surface) {
    guac_palette* palette;
    guac_palette_prepare_internal(surface, &palette, NULL);
    return palette;
}

int guac_palette_find(guac_palette* palette, int color) {
    return guac_palette_lookup(palette, color)->index - 1;
}

void guac_palette_free(guac_palette* palette) {
    guac_mem_free(palette);
}

