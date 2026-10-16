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

#include "../../display-diagnostics.h"
#include "../../encode-png.h"
#include "../../palette.h"
#include "guacamole/error.h"
#include "guacamole/mem.h"

#include <CUnit/CUnit.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void* png_test_alloc(size_t count, const size_t* factors);
static void* png_test_zalloc(size_t count, const size_t* factors);
static void png_test_free(void* memory);
static png_structp png_test_create_write_struct(png_const_charp version,
        png_voidp error, png_error_ptr fatal, png_error_ptr warning);
static png_infop png_test_create_info_struct(png_const_structrp png);
static void png_test_set_write_fn(png_structrp png, png_voidp io,
        png_rw_ptr write, png_flush_ptr flush);
static guac_display_render_sample* png_test_current_sample(void);
static int png_test_send_blob(guac_display_render_sample* sample,
        guac_socket* socket, guac_stream* stream, const void* data, int length);

guac_palette* png_test_palette_alloc(cairo_surface_t* surface);
int png_test_palette_prepare(cairo_surface_t* surface, guac_palette** palette,
        png_byte*** rows);
int png_test_palette_find(guac_palette* palette, int color);
void png_test_palette_free(guac_palette* palette);

/* Inject allocation/output faults into the actual encoder and palette code.
 * Libpng and Cairo are real; no synthetic PNG decoder or encoder is used. */
#define PRIV_guac_mem_alloc png_test_alloc
#define PRIV_guac_mem_zalloc png_test_zalloc
#define PRIV_guac_mem_free png_test_free
#define guac_palette_alloc png_test_palette_alloc
#define guac_palette_prepare png_test_palette_prepare
#define guac_palette_find png_test_palette_find
#define guac_palette_free png_test_palette_free
#include "../../palette.c"
#define guac_png_write png_test_write
#define png_create_write_struct png_test_create_write_struct
#define png_create_info_struct png_test_create_info_struct
#define png_set_write_fn png_test_set_write_fn
#define guac_display_diagnostics_current png_test_current_sample
#define guac_display_diagnostics_send_blob png_test_send_blob
#include "../../encode-png.c"
#undef PRIV_guac_mem_alloc
#undef PRIV_guac_mem_zalloc
#undef PRIV_guac_mem_free
#undef guac_palette_alloc
#undef guac_palette_prepare
#undef guac_palette_find
#undef guac_palette_free
#undef guac_png_write
#undef png_create_write_struct
#undef png_create_info_struct
#undef png_set_write_fn
#undef guac_display_diagnostics_current
#undef guac_display_diagnostics_send_blob

/** Only Guacamole-owned allocations are tracked, not libpng/Cairo internals. */
static void* png_test_allocations[512];
static int png_test_live;
static int png_test_attempts;
static int png_test_fail_allocation;
static int png_test_fail_allocation_again;
static size_t png_test_largest_allocation;
static int png_test_fail_create;
static int png_test_fail_write;
static int png_test_write_calls;
static int png_test_blob_calls;
static int png_test_fail_after_blob;
static png_rw_ptr png_test_original_write;

static void png_test_reset(void) {
    CU_ASSERT_EQUAL(png_test_live, 0);
    memset(png_test_allocations, 0, sizeof(png_test_allocations));
    png_test_attempts = 0;
    png_test_fail_allocation = 0;
    png_test_fail_allocation_again = 0;
    png_test_largest_allocation = 0;
    png_test_fail_create = 0;
    png_test_fail_write = -1;
    png_test_write_calls = 0;
    png_test_blob_calls = 0;
    png_test_fail_after_blob = 0;
    guac_error = GUAC_STATUS_SUCCESS;
}

static void* png_test_allocate(size_t count, const size_t* factors, int zero) {
    size_t bytes = 1;
    for (size_t i = 0; i < count; i++)
        bytes *= factors[i];
    if (bytes > png_test_largest_allocation)
        png_test_largest_allocation = bytes;
    ++png_test_attempts;
    if (png_test_attempts == png_test_fail_allocation
            || png_test_attempts == png_test_fail_allocation_again) {
        guac_error = GUAC_STATUS_NO_MEMORY;
        guac_error_message = "Injected PNG allocation failure";
        return NULL;
    }
    void* memory = zero ? PRIV_guac_mem_zalloc(count, factors)
        : PRIV_guac_mem_alloc(count, factors);
    CU_ASSERT_PTR_NOT_NULL_FATAL(memory);
    size_t index;
    for (index = 0; index < sizeof(png_test_allocations) / sizeof(void*); index++) {
        if (png_test_allocations[index] == NULL) {
            png_test_allocations[index] = memory;
            png_test_live++;
            return memory;
        }
    }
    CU_FAIL_FATAL("Unexpectedly many PNG allocations");
    return NULL;
}

static void* png_test_alloc(size_t count, const size_t* factors) {
    return png_test_allocate(count, factors, 0);
}

static void* png_test_zalloc(size_t count, const size_t* factors) {
    return png_test_allocate(count, factors, 1);
}

static void png_test_free(void* memory) {
    if (memory == NULL)
        return;
    for (size_t i = 0; i < sizeof(png_test_allocations) / sizeof(void*); i++) {
        if (png_test_allocations[i] == memory) {
            png_test_allocations[i] = NULL;
            png_test_live--;
            PRIV_guac_mem_free(memory);
            return;
        }
    }
    CU_FAIL_FATAL("PNG freed an unowned or already freed allocation");
}

static void png_test_error(png_structp png, png_const_charp message) {
    longjmp(png_jmpbuf(png), 1);
}

static png_structp png_test_create_write_struct(png_const_charp version,
        png_voidp error, png_error_ptr fatal, png_error_ptr warning) {
    if (png_test_fail_create == 1)
        return NULL;
    return png_create_write_struct(version, error, png_test_error, warning);
}

static png_infop png_test_create_info_struct(png_const_structrp png) {
    return png_test_fail_create == 2 ? NULL : png_create_info_struct(png);
}

static void png_test_write_data(png_structp png, png_bytep data, png_size_t length) {
    if (png_test_write_calls++ == png_test_fail_write
            || (png_test_fail_after_blob && png_test_blob_calls != 0))
        png_error(png, "Injected PNG output failure");
    png_test_original_write(png, data, length);
}

static void png_test_set_write_fn(png_structrp png, png_voidp io,
        png_rw_ptr write, png_flush_ptr flush) {
    png_test_original_write = write;
    png_set_write_fn(png, io, png_test_write_data, flush);
}

typedef struct png_test_buffer {
    unsigned char* data;
    size_t size;
    size_t capacity;
    size_t offset;
} png_test_buffer;

static void png_test_append(png_test_buffer* buffer, const void* data, size_t length) {
    if (buffer->size + length > buffer->capacity) {
        buffer->capacity = (buffer->size + length) * 2 + 1024;
        buffer->data = realloc(buffer->data, buffer->capacity);
        CU_ASSERT_PTR_NOT_NULL_FATAL(buffer->data);
    }
    if (length != 0)
        memcpy(buffer->data + buffer->size, data, length);
    buffer->size += length;
}

static guac_display_render_sample* png_test_current_sample(void) {
    return NULL;
}

static int png_test_send_blob(guac_display_render_sample* sample,
        guac_socket* socket, guac_stream* stream, const void* data, int length) {
    CU_ASSERT_TRUE_FATAL(length >= 0);
    png_test_blob_calls++;
    png_test_append(socket->data, data, (size_t) length);
    return 0;
}

static void png_test_reference_write(png_structp png, png_bytep data, png_size_t length) {
    png_test_append(png_get_io_ptr(png), data, length);
}

static cairo_status_t png_test_cairo_write(void* closure,
        const unsigned char* data, unsigned int length) {
    png_test_append(closure, data, length);
    return CAIRO_STATUS_SUCCESS;
}

static cairo_status_t png_test_cairo_read(void* closure,
        unsigned char* data, unsigned int length) {
    png_test_buffer* buffer = closure;
    if (length > buffer->size - buffer->offset)
        return CAIRO_STATUS_READ_ERROR;
    memcpy(data, buffer->data + buffer->offset, length);
    buffer->offset += length;
    return CAIRO_STATUS_SUCCESS;
}

/** Independent first-seen oracle. Linear color lookup deliberately shares no
 * production hash, run cache or fused-index preparation logic. */
static int png_test_reference_palette(cairo_surface_t* surface, png_color* colors,
        png_bytep* rows) {
    int width = cairo_image_surface_get_width(surface);
    int height = cairo_image_surface_get_height(surface);
    int stride = cairo_image_surface_get_stride(surface);
    const unsigned char* source = cairo_image_surface_get_data(surface);
    uint32_t values[256];
    int size = 0;
    for (int y = 0; y < height; y++) {
        const uint32_t* row = (const uint32_t*) source;
        for (int x = 0; x < width; x++) {
            uint32_t color = row[x] & 0xFFFFFFU;
            int index;
            for (index = 0; index < size; index++)
                if (values[index] == color)
                    break;
            if (index == size) {
                if (size == 256)
                    return 0;
                values[index] = color;
                colors[index].red = color >> 16;
                colors[index].green = (color >> 8) & 255;
                colors[index].blue = color & 255;
                size++;
            }
            rows[y][x] = (png_byte) index;
        }
        if (y + 1 < height)
            source += stride;
    }
    return size;
}

/** Compatibility oracle: private.8's separate-per-row staging and libpng API.
 * This intentionally uses the system libpng defaults rather than a golden
 * payload tied to one particular libpng/zlib release. */
static void png_test_reference(cairo_surface_t* surface, png_test_buffer* buffer) {
    int width = cairo_image_surface_get_width(surface);
    int height = cairo_image_surface_get_height(surface);
    png_bytep* rows = calloc((size_t) height, sizeof(*rows));
    CU_ASSERT_PTR_NOT_NULL_FATAL(rows);
    for (int y = 0; y < height; y++) {
        rows[y] = malloc((size_t) width);
        CU_ASSERT_PTR_NOT_NULL_FATAL(rows[y]);
    }
    png_color colors[256];
    int size = cairo_image_surface_get_format(surface) == CAIRO_FORMAT_RGB24
        ? png_test_reference_palette(surface, colors, rows) : 0;
    if (size == 0) {
        CU_ASSERT_EQUAL(cairo_surface_write_to_png_stream(surface,
                    png_test_cairo_write, buffer), CAIRO_STATUS_SUCCESS);
        for (int y = 0; y < height; y++)
            free(rows[y]);
        free(rows);
        return;
    }
    int bpp = size <= 2 ? 1 : size <= 4 ? 2 : size <= 16 ? 4 : 8;
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
    CU_ASSERT_PTR_NOT_NULL_FATAL(png);
    png_infop info = png_create_info_struct(png);
    CU_ASSERT_PTR_NOT_NULL_FATAL(info);
    if (!setjmp(png_jmpbuf(png))) {
        png_set_write_fn(png, buffer, png_test_reference_write, NULL);
        png_set_IHDR(png, info, width, height, bpp, PNG_COLOR_TYPE_PALETTE,
                PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
        png_set_PLTE(png, info, colors, size);
        png_set_rows(png, info, rows);
        png_write_png(png, info, PNG_TRANSFORM_PACKING, NULL);
    }
    else
        CU_FAIL("Reference PNG encoder failed");
    png_destroy_write_struct(&png, &info);
    for (int y = 0; y < height; y++)
        free(rows[y]);
    free(rows);
}

typedef struct png_test_fixture {
    cairo_surface_t* surface;
    unsigned char* storage;
    size_t storage_size;
} png_test_fixture;

/** Padded rows and a nonzero aligned origin exercise offset/stride handling.
 * The subrectangle reaches the parent's last row: advancing by its stride
 * after that final row would form a pointer beyond the backing allocation. */
static png_test_fixture png_test_surface(int colors, int height, int alpha) {
    int width = 19;
    int stride = (width + 9) * 4;
    png_test_fixture fixture = { 0 };
    fixture.storage_size = (size_t) (height + 2) * stride;
    fixture.storage = malloc(fixture.storage_size);
    CU_ASSERT_PTR_NOT_NULL_FATAL(fixture.storage);
    memset(fixture.storage, 0xCD, fixture.storage_size);
    unsigned char* origin = fixture.storage + 2 * stride + 3 * 4;
    for (int y = 0; y < height; y++) {
        uint32_t* row = (uint32_t*) (origin + y * stride);
        for (int x = 0; x < width; x++) {
            unsigned int index = (y * width + x) % colors;
            row[x] = alpha ? (index & 1 ? 0x80800000U : 0x40004000U)
                : ((index * 0x010307U) & 0xFFFFFFU)
                    | ((unsigned int) ((x * 53 + y * 29) & 255) << 24);
        }
    }
    fixture.surface = cairo_image_surface_create_for_data(origin,
            alpha ? CAIRO_FORMAT_ARGB32 : CAIRO_FORMAT_RGB24, width, height, stride);
    CU_ASSERT_EQUAL_FATAL(cairo_surface_status(fixture.surface), CAIRO_STATUS_SUCCESS);
    return fixture;
}

static void png_test_free_surface(png_test_fixture* fixture) {
    cairo_surface_destroy(fixture->surface);
    free(fixture->storage);
}

/** Generic padded RGB24 image, including a negative-stride view whose last
 * visible row reaches the bottom of its exact backing allocation. */
static png_test_fixture png_test_custom_surface(int width, int height, int negative) {
    int stride = (width + 9) * 4;
    png_test_fixture fixture = { 0 };
    fixture.storage_size = (size_t) height * stride;
    fixture.storage = malloc(fixture.storage_size);
    CU_ASSERT_PTR_NOT_NULL_FATAL(fixture.storage);
    memset(fixture.storage, 0xCD, fixture.storage_size);
    unsigned char* origin = fixture.storage + 3 * 4;
    if (negative)
        origin += (height - 1) * stride;
    fixture.surface = cairo_image_surface_create_for_data(origin,
            CAIRO_FORMAT_RGB24, width, height, negative ? -stride : stride);
    CU_ASSERT_EQUAL_FATAL(cairo_surface_status(fixture.surface), CAIRO_STATUS_SUCCESS);
    return fixture;
}

/** Compare every decoded pixel independently of the compatibility encoder. */
static void png_test_pixels(cairo_surface_t* original, png_test_buffer* png) {
    cairo_surface_t* decoded = cairo_image_surface_create_from_png_stream(
            png_test_cairo_read, png);
    CU_ASSERT_EQUAL_FATAL(cairo_surface_status(decoded), CAIRO_STATUS_SUCCESS);
    int width = cairo_image_surface_get_width(original);
    int height = cairo_image_surface_get_height(original);
    CU_ASSERT_EQUAL(cairo_image_surface_get_width(decoded), width);
    CU_ASSERT_EQUAL(cairo_image_surface_get_height(decoded), height);
    int source_stride = cairo_image_surface_get_stride(original);
    int decoded_stride = cairo_image_surface_get_stride(decoded);
    unsigned char* source = cairo_image_surface_get_data(original);
    unsigned char* actual = cairo_image_surface_get_data(decoded);
    uint32_t mask = cairo_image_surface_get_format(original) == CAIRO_FORMAT_RGB24
        ? 0xFFFFFFU : 0xFFFFFFFFU;
    for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++)
            CU_ASSERT_EQUAL(((uint32_t*) (source + y * source_stride))[x] & mask,
                    ((uint32_t*) (actual + y * decoded_stride))[x] & mask);
    }
    cairo_surface_destroy(decoded);
}

/** Success is checked against a separate palette implementation and a real
 * decoder; allocation observations are saved before running the oracle. */
static int png_test_check_fixture(png_test_fixture* fixture, int bpp, int type) {
    unsigned char* before = malloc(fixture->storage_size);
    CU_ASSERT_PTR_NOT_NULL_FATAL(before);
    memcpy(before, fixture->storage, fixture->storage_size);
    png_test_buffer actual = { 0 }, reference = { 0 };
    guac_socket socket = { .data = &actual };
    CU_ASSERT_EQUAL_FATAL(png_test_write(&socket, NULL, fixture->surface), 0);
    CU_ASSERT_EQUAL(png_test_live, 0);
    int attempts = png_test_attempts;
    png_test_reference(fixture->surface, &reference);
    CU_ASSERT_EQUAL_FATAL(actual.size, reference.size);
    CU_ASSERT_EQUAL(memcmp(actual.data, reference.data, actual.size), 0);
    CU_ASSERT_TRUE_FATAL(actual.size > 25);
    CU_ASSERT_EQUAL(actual.data[24], bpp);
    CU_ASSERT_EQUAL(actual.data[25], type);
    png_test_pixels(fixture->surface, &actual);
    CU_ASSERT_EQUAL(memcmp(before, fixture->storage, fixture->storage_size), 0);
    free(before);
    free(actual.data);
    free(reference.data);
    return attempts;
}

/** Grayscale, former XOR collisions and deliberately colliding new-hash colors
 * all retain first-seen palette order and identical packed output. */
void test_encode_png__fused_palette_order_collisions_and_signed_stride() {
    for (int pattern = 0; pattern < 3; pattern++) {
        uint32_t colors[256];
        int found = 0;
        for (uint32_t color = 0; found < 256; color++) {
            if (pattern == 0)
                colors[found++] = color * 0x010101U;
            else if (pattern == 1)
                colors[found++] = (color << 12) | color;
            else if (guac_palette_hash((int) color) == 0)
                colors[found++] = color;
        }
        for (int negative = 0; negative < 2; negative++) {
            png_test_reset();
            png_test_fixture fixture = png_test_custom_surface(257, 19, negative);
            unsigned char* data = cairo_image_surface_get_data(fixture.surface);
            int stride = cairo_image_surface_get_stride(fixture.surface);
            for (int y = 0; y < 19; y++) {
                uint32_t* row = (uint32_t*) (data + y * stride);
                for (int x = 0; x < 257; x++)
                    row[x] = colors[(x * 71 + y * 19) & 255]
                        | ((uint32_t) ((x + y) & 255) << 24);
            }
            CU_ASSERT_EQUAL(png_test_check_fixture(&fixture, 8, PNG_COLOR_TYPE_PALETTE), 2);
            guac_palette* palette = png_test_palette_alloc(fixture.surface);
            CU_ASSERT_PTR_NOT_NULL_FATAL(palette);
            CU_ASSERT_EQUAL(palette->size, 256);
            for (int x = 0; x < 256; x++)
                CU_ASSERT_EQUAL(png_test_palette_find(palette,
                            colors[(x * 71) & 255]), x);
            uint32_t absent = 0;
            for (;;) {
                int present = 0;
                for (int i = 0; i < 256; i++)
                    present |= colors[i] == absent;
                if (!present)
                    break;
                absent++;
            }
            CU_ASSERT_EQUAL(png_test_palette_find(palette, (int) absent), -1);
            png_test_palette_free(palette);
            CU_ASSERT_EQUAL(png_test_live, 0);
            png_test_free_surface(&fixture);
        }
    }
}

/** Colors introduced only after the fixed prefix still choose their final
 * packing depth, and an initially solid run can still exceed palette capacity. */
void test_encode_png__palette_growth_after_prefix_preserves_packing() {
    int counts[] = { 2, 4, 16, 256, 257 };
    int depths[] = { 1, 2, 4, 8, 8 };
    for (size_t c = 0; c < sizeof(counts) / sizeof(*counts); c++) {
        png_test_reset();
        png_test_fixture fixture = png_test_custom_surface(257, 19, 0);
        unsigned char* data = cairo_image_surface_get_data(fixture.surface);
        int stride = cairo_image_surface_get_stride(fixture.surface);
        for (int y = 0; y < 19; y++) {
            uint32_t* row = (uint32_t*) (data + y * stride);
            for (int x = 0; x < 257; x++) {
                int position = y * 257 + x;
                row[x] = position < GUAC_PALETTE_INDEX_PREFIX_SIZE ? 0
                    : (uint32_t) ((position - GUAC_PALETTE_INDEX_PREFIX_SIZE) % counts[c]);
            }
        }
        CU_ASSERT_EQUAL(png_test_check_fixture(&fixture, depths[c],
                    counts[c] <= 256 ? PNG_COLOR_TYPE_PALETTE : PNG_COLOR_TYPE_RGB), 2);
        png_test_free_surface(&fixture);
    }
}

/** Rows above the speculation cap are allocated only after palette preflight.
 * A very tall narrow image must include pointer bytes in that cap decision. */
void test_encode_png__speculation_bound_includes_row_table() {
    int widths[] = { 256 - (int) sizeof(png_byte*), 257 - (int) sizeof(png_byte*), 1 };
    int heights[] = { 256, 256, 10000 };
    for (int fixture_index = 0; fixture_index < 3; fixture_index++) {
        int width = widths[fixture_index], height = heights[fixture_index];
        png_test_reset();
        png_test_fixture fixture = png_test_custom_surface(width, height, 0);
        unsigned char* data = cairo_image_surface_get_data(fixture.surface);
        int stride = cairo_image_surface_get_stride(fixture.surface);
        for (int y = 0; y < height; y++) {
            uint32_t* row = (uint32_t*) (data + y * stride);
            for (int x = 0; x < width; x++)
                row[x] = (uint32_t) ((y * width + x) & 255) * 0x010101U;
        }
        /* The 257th color arrives after the fixed prefix has been consumed. */
        ((uint32_t*) (data + (height - 1) * stride))[width - 1] = 0x123456U;
        int expected = ((size_t) width + sizeof(png_byte*)) * height
            <= GUAC_PALETTE_INDEX_MAX_BYTES ? 2 : 1;
        CU_ASSERT_EQUAL(png_test_check_fixture(&fixture, 8, PNG_COLOR_TYPE_RGB), expected);
        CU_ASSERT_TRUE(png_test_largest_allocation <= GUAC_PALETTE_INDEX_MAX_BYTES);
        png_test_free_surface(&fixture);
    }
}

/** A large ordinary high-color image rejects the palette before allocating a
 * whole-image index buffer; the late high-color case above also stays bounded. */
void test_encode_png__large_high_color_fallback_does_not_stage_indices() {
    png_test_reset();
    png_test_fixture fixture = png_test_custom_surface(1024, 128, 0);
    unsigned char* data = cairo_image_surface_get_data(fixture.surface);
    int stride = cairo_image_surface_get_stride(fixture.surface);
    for (int y = 0; y < 128; y++) {
        uint32_t* row = (uint32_t*) (data + y * stride);
        for (int x = 0; x < 1024; x++)
            row[x] = (uint32_t) (y * 1024 + x);
    }
    CU_ASSERT_EQUAL(png_test_check_fixture(&fixture, 8, PNG_COLOR_TYPE_RGB), 1);
    CU_ASSERT_EQUAL(png_test_largest_allocation, sizeof(guac_palette));
    png_test_free_surface(&fixture);
}

/** Optional fused staging OOM must not prevent a later Cairo fallback, and an
 * eligible palette retries the original final allocation after preflight. */
void test_encode_png__speculative_oom_preflights_and_retries_safely() {
    for (int high_color = 0; high_color < 2; high_color++) {
        png_test_reset();
        png_test_fail_allocation = 2;
        png_test_fixture fixture = png_test_custom_surface(257, 19, 0);
        unsigned char* data = cairo_image_surface_get_data(fixture.surface);
        int stride = cairo_image_surface_get_stride(fixture.surface);
        for (int y = 0; y < 19; y++) {
            uint32_t* row = (uint32_t*) (data + y * stride);
            for (int x = 0; x < 257; x++)
                row[x] = (uint32_t) ((y * 257 + x) & 255) * 0x010101U;
        }
        if (high_color)
            ((uint32_t*) (data + 18 * stride))[256] = 0x123456U;
        CU_ASSERT_EQUAL(png_test_check_fixture(&fixture, 8,
                    high_color ? PNG_COLOR_TYPE_RGB : PNG_COLOR_TYPE_PALETTE),
                high_color ? 2 : 3);
        png_test_free_surface(&fixture);
    }
}

/** If both optional and final allocations fail, there is no partial output or
 * leaked palette. This is the original indexed-staging allocation failure. */
void test_encode_png__speculative_and_final_oom_cleans_up() {
    png_test_reset();
    png_test_fail_allocation = 2;
    png_test_fail_allocation_again = 3;
    png_test_fixture fixture = png_test_surface(17, 257, 0);
    png_test_buffer output = { 0 };
    guac_socket socket = { .data = &output };
    CU_ASSERT_EQUAL(png_test_write(&socket, NULL, fixture.surface), -1);
    CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_NO_MEMORY);
    CU_ASSERT_EQUAL(png_test_attempts, 3);
    CU_ASSERT_EQUAL(png_test_live, 0);
    CU_ASSERT_EQUAL(output.size, 0);
    free(output.data);
    png_test_free_surface(&fixture);
}

static void png_test_success(int colors, int height, int alpha, int expected_bpp) {
    png_test_reset();
    png_test_fixture fixture = png_test_surface(colors, height, alpha);
    unsigned char* before = malloc(fixture.storage_size);
    CU_ASSERT_PTR_NOT_NULL_FATAL(before);
    memcpy(before, fixture.storage, fixture.storage_size);
    png_test_buffer actual = { 0 }, reference = { 0 };
    guac_socket socket = { .data = &actual };
    CU_ASSERT_EQUAL_FATAL(png_test_write(&socket, NULL, fixture.surface), 0);
    CU_ASSERT_EQUAL(png_test_live, 0);
    CU_ASSERT_EQUAL(png_test_attempts, alpha ? 0 : colors <= 256 ? 2 : 1);
    png_test_reference(fixture.surface, &reference);
    CU_ASSERT_EQUAL_FATAL(actual.size, reference.size);
    CU_ASSERT_EQUAL(memcmp(actual.data, reference.data, actual.size), 0);
    CU_ASSERT_TRUE_FATAL(actual.size > 25);
    CU_ASSERT_EQUAL(actual.data[24], expected_bpp);
    CU_ASSERT_EQUAL(actual.data[25], colors <= 256 && !alpha
            ? PNG_COLOR_TYPE_PALETTE : alpha ? PNG_COLOR_TYPE_RGB_ALPHA : PNG_COLOR_TYPE_RGB);
    png_test_pixels(fixture.surface, &actual);
    CU_ASSERT_EQUAL(memcmp(before, fixture.storage, fixture.storage_size), 0);
    free(before);
    free(actual.data);
    free(reference.data);
    png_test_free_surface(&fixture);
}

/** Exact payloads and pixels at every packing boundary, with odd row widths. */
void test_encode_png__palette_depths_match_legacy_payload() {
    int colors[] = { 1, 2, 3, 4, 5, 16, 17, 255, 256 };
    int depth[] = { 1, 1, 2, 2, 4, 4, 8, 8, 8 };
    for (size_t i = 0; i < sizeof(colors) / sizeof(*colors); i++)
        png_test_success(colors[i], 19, 0, depth[i]);
}

/** Row staging allocation count is constant even for a tall indexed image. */
void test_encode_png__tall_palette_uses_single_row_block() {
    png_test_success(17, 257, 0, 8);
}

/** High-color and premultiplied alpha surfaces retain the Cairo fallback. */
void test_encode_png__cairo_fallback_payloads_unchanged() {
    png_test_success(257, 19, 0, 8);
    png_test_success(2, 19, 1, 8);
}

/** Allocation failure before setjmp returns an error and releases the palette. */
void test_encode_png__row_allocation_failure_cleans_up() {
    png_test_reset();
    png_test_fail_allocation = 2;
    png_test_fixture fixture = png_test_surface(4, 19, 0);
    png_test_buffer output = { 0 };
    guac_socket socket = { .data = &output };
    CU_ASSERT_EQUAL(png_test_write(&socket, NULL, fixture.surface), -1);
    CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_NO_MEMORY);
    CU_ASSERT_EQUAL(png_test_live, 0);
    CU_ASSERT_EQUAL(output.size, 0);
    free(output.data);
    png_test_free_surface(&fixture);
}

/** A failed palette allocation is never dereferenced and retains fallback. */
void test_encode_png__palette_allocation_failure_uses_cairo() {
    png_test_reset();
    png_test_fail_allocation = 1;
    png_test_fixture fixture = png_test_surface(4, 19, 0);
    png_test_buffer output = { 0 }, expected = { 0 };
    guac_socket socket = { .data = &output };
    CU_ASSERT_EQUAL(png_test_write(&socket, NULL, fixture.surface), 0);
    CU_ASSERT_EQUAL(png_test_live, 0);
    CU_ASSERT_EQUAL(cairo_surface_write_to_png_stream(fixture.surface,
                png_test_cairo_write, &expected), CAIRO_STATUS_SUCCESS);
    CU_ASSERT_EQUAL_FATAL(output.size, expected.size);
    CU_ASSERT_EQUAL(memcmp(output.data, expected.data, output.size), 0);
    png_test_pixels(fixture.surface, &output);
    free(output.data);
    free(expected.data);
    png_test_free_surface(&fixture);
}

/** Both libpng creation failures release the single staged block and palette. */
void test_encode_png__libpng_creation_failure_cleans_up() {
    for (int failure = 1; failure <= 2; failure++) {
        png_test_reset();
        png_test_fail_create = failure;
        png_test_fixture fixture = png_test_surface(4, 19, 0);
        png_test_buffer output = { 0 };
        guac_socket socket = { .data = &output };
        CU_ASSERT_EQUAL(png_test_write(&socket, NULL, fixture.surface), -1);
        CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_INTERNAL_ERROR);
        CU_ASSERT_EQUAL(png_test_live, 0);
        CU_ASSERT_EQUAL(output.size, 0);
        free(output.data);
        png_test_free_surface(&fixture);
    }
}

/** Real libpng longjmps before and after output release all staged row memory. */
void test_encode_png__libpng_longjmp_cleans_up_rows() {
    for (int failure = 0; failure <= 2; failure++) {
        png_test_reset();
        png_test_fail_write = failure;
        png_test_fixture fixture = png_test_surface(17, 257, 0);
        png_test_buffer output = { 0 };
        guac_socket socket = { .data = &output };
        CU_ASSERT_EQUAL(png_test_write(&socket, NULL, fixture.surface), -1);
        CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_IO_ERROR);
        CU_ASSERT_EQUAL(png_test_live, 0);
        CU_ASSERT_EQUAL(png_test_attempts, 2);
        free(output.data);
        png_test_free_surface(&fixture);
    }
}

/** A late IDAT error after a real blob send also frees all staging memory. */
void test_encode_png__libpng_longjmp_after_blob_cleans_up_rows() {
    png_test_reset();
    png_test_fail_after_blob = 1;
    png_test_fixture fixture = png_test_surface(256, 4097, 0);
    unsigned char* data = cairo_image_surface_get_data(fixture.surface);
    int stride = cairo_image_surface_get_stride(fixture.surface);
    uint32_t random = 1;
    for (int y = 0; y < 4097; y++) {
        uint32_t* row = (uint32_t*) (data + y * stride);
        for (int x = 0; x < 19; x++) {
            random = random * 1664525U + 1013904223U;
            row[x] = ((random >> 24) * 0x010307U) & 0xFFFFFFU;
        }
    }
    png_test_buffer output = { 0 };
    guac_socket socket = { .data = &output };
    CU_ASSERT_EQUAL(png_test_write(&socket, NULL, fixture.surface), -1);
    CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_IO_ERROR);
    CU_ASSERT_TRUE(png_test_blob_calls > 0);
    CU_ASSERT_TRUE(output.size > 0);
    CU_ASSERT_EQUAL(png_test_live, 0);
    CU_ASSERT_EQUAL(png_test_attempts, 2);
    free(output.data);
    png_test_free_surface(&fixture);
}
