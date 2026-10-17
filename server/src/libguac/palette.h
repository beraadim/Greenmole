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

#ifndef __GUAC_PALETTE_H
#define __GUAC_PALETTE_H

#include <cairo/cairo.h>
#include <png.h>

typedef struct guac_palette_entry {

    int index;
    int color;

} guac_palette_entry;

typedef struct guac_palette {

    guac_palette_entry entries[0x1000];
    png_color colors[256];
    int size;

} guac_palette;

/** Maximum speculative row-table and index bytes before palette eligibility. */
#define GUAC_PALETTE_INDEX_MAX_BYTES (64U * 1024U)

/**
 * Prepares an RGB24 palette and the contiguous row table/index bytes required
 * by libpng. First-seen row-major color order is retained. Small images fuse
 * construction and indexing with bounded speculation; larger images retain
 * the preflight pass before allocating their full row block.
 *
 * @return
 *     One on success, zero if the caller should use the Cairo fallback (more
 *     than 256 colors or palette OOM), or -1 if final index allocation fails.
 *     On failure both output pointers are NULL. On success free rows with
 *     guac_mem_free() and palette with guac_palette_free().
 */
int guac_palette_prepare(cairo_surface_t* surface, guac_palette** palette,
        png_byte*** rows);

guac_palette* guac_palette_alloc(cairo_surface_t* surface);
int guac_palette_find(guac_palette* palette, int color);
void guac_palette_free(guac_palette* palette);

#endif

