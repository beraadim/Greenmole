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

#include "../../display-priv.h"

#include <CUnit/CUnit.h>
#include <guacamole/mem.h>
#include <guacamole/user.h>

#include <stdint.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

/* Structural observations exist only in this source-injected copy. The real
 * library has no classification counters, callback or per-pixel test hook. */
static uint64_t classifier_comparisons;
static uint64_t classifier_rows;
#define GUAC_DISPLAY_CLASSIFY_ROW(count) \
    do { classifier_comparisons += (count); classifier_rows++; } while (0)
#define LFR_guac_display_layer_image_format classifier_image_format
#define guac_display_worker_thread classifier_unstarted_worker
#include "../../display-worker.c"
#undef guac_display_worker_thread
#undef LFR_guac_display_layer_image_format
#undef GUAC_DISPLAY_CLASSIFY_ROW

/** A separate complete scan uses the original score with widened arithmetic.
 * It shares no early-exit bounds or traversal counters with production. */
static int classifier_full_scan(const unsigned char* pixels, size_t stride,
        const guac_rect* rect) {
    int64_t width = (int64_t) rect->right - rect->left;
    int64_t height = (int64_t) rect->bottom - rect->top;
    if (width <= 0 || height <= 0)
        return 1;
    uint64_t same = 0, different = 1;
    for (int64_t y = 0; y < height; y++) {
        for (int64_t x = 1; x < width; x++) {
            const uint32_t* row = (const uint32_t*) (pixels
                    + ((size_t) rect->top + y) * stride);
            if ((row[rect->left + x - 1] & 0xFFFFFF)
                    == (row[rect->left + x] & 0xFFFFFF))
                same++;
            else
                different++;
        }
    }
    return UINT64_C(256) * same / different >= 1024;
}

static int classifier_preference(unsigned char* pixels, size_t stride,
        const guac_rect* rect) {
    guac_display_layer layer = { 0 };
    layer.last_frame.buffer = pixels;
    layer.last_frame.buffer_stride = stride;
    classifier_comparisons = classifier_rows = 0;
    return LFR_guac_display_layer_prefers_png(&layer, rect);
}

/** Make exactly same_count equal horizontal pairs, arranged early, late or
 * spread throughout the region. Every row starts independently, as required by
 * the historical heuristic. High bytes vary independently of RGB equality. */
static void classifier_fixture(uint32_t* pixels, int width, int height,
        uint64_t same_count, int arrangement) {
    uint64_t total = (uint64_t) (width - 1) * height;
    uint64_t position = 0;
    for (int y = 0; y < height; y++) {
        uint32_t color = (uint32_t) y * 17;
        pixels[(size_t) y * width] = color | ((uint32_t) y << 24);
        for (int x = 1; x < width; x++, position++) {
            int same;
            if (arrangement == 0)
                same = position < same_count;
            else if (arrangement == 1)
                same = position >= total - same_count;
            else
                same = (position + 1) * same_count / total
                    > position * same_count / total;
            if (!same)
                color = (color + 0x10203) & 0xFFFFFF;
            pixels[(size_t) y * width + x] = color
                | ((uint32_t) (position & 0xFF) << 24);
        }
    }
}

/**
 * Chooses an image format for a layer containing the given pixels and a single
 * viewer advertising the requested capabilities. No rendering threads or
 * network connection are needed to exercise the encoding policy.
 */
static guac_display_image_format image_format(uint32_t* pixels, int width,
        int height, int framerate, int opaque, int lossless, int webp) {

    const char* png_only[] = { "image/png", NULL };
    const char* with_webp[] = { "image/png", "image/webp", NULL };
    guac_user user = { 0 };
    user.info.image_mimetypes = webp ? with_webp : png_only;

    guac_client client = { 0 };
    client.__users = &user;
    guac_rwlock_init(&client.__users_lock);

    /* guac_display contains a large operation FIFO, so keep it off the stack. */
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    display->client = &client;
    guac_display_layer layer = { 0 };
    layer.display = display;
    layer.opaque = opaque;
    layer.last_frame.lossless = lossless;
    layer.last_frame.buffer = (unsigned char*) pixels;
    layer.last_frame.buffer_stride = width * sizeof(uint32_t);
    guac_rect rect = { .left = 0, .top = 0, .right = width, .bottom = height };

    guac_display_image_format format =
        LFR_guac_display_layer_image_format(&layer, &rect, framerate);
    CU_ASSERT_EQUAL(classifier_image_format(&layer, &rect, framerate), format);

    guac_mem_free(display);
    guac_rwlock_destroy(&client.__users_lock);
    return format;

}

/**
 * PNG must remain preferred for repetitive image contents, even when both
 * alternative codecs are available and the region is changing rapidly.
 */
void test_display__repetitive_contents_prefer_png() {

    uint32_t pixels[65 * 65] = { 0 };
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 60, 1, 0, 0),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 60, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);

}

/**
 * JPEG requires an opaque, lossy layer, sufficient update frequency, and a
 * rectangle strictly larger than its minimum size. Check each boundary using
 * image contents with no adjacent repeated pixels.
 */
void test_display__jpeg_constraints() {

    uint32_t pixels[65 * 65];
    for (unsigned int i = 0; i < 65 * 65; i++)
        pixels[i] = i;

    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 3, 1, 0, 0),
            GUAC_DISPLAY_IMAGE_FORMAT_JPEG);
    CU_ASSERT_EQUAL(image_format(pixels, 64, 64, 3, 1, 0, 0),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 2, 1, 0, 0),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 3, 0, 0, 0),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 3, 1, 1, 0),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);

}

/**
 * WebP takes precedence over JPEG if advertised and built in. Unlike JPEG,
 * WebP can encode transparent, lossless, and small images. Low-frequency
 * changes still use PNG.
 */
void test_display__webp_capabilities() {

    uint32_t pixels[65 * 65];
    for (unsigned int i = 0; i < 65 * 65; i++)
        pixels[i] = i;

#ifdef ENABLE_WEBP
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 3, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_WEBP);
    CU_ASSERT_EQUAL(image_format(pixels, 64, 64, 3, 0, 1, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_WEBP);
#else
    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 3, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_JPEG);
    CU_ASSERT_EQUAL(image_format(pixels, 64, 64, 3, 0, 1, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
#endif

    CU_ASSERT_EQUAL(image_format(pixels, 65, 65, 2, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);

}

void test_display__image_classification_matches_full_scan_near_threshold() {
    const int widths[] = {2, 3, 5, 11, 64, 65, 257};
    const int heights[] = {1, 2, 19, 128};
    for (size_t w = 0; w < sizeof(widths) / sizeof(*widths); w++) {
        for (size_t h = 0; h < sizeof(heights) / sizeof(*heights); h++) {
            int width = widths[w], height = heights[h];
            guac_rect rect = {.right = width, .bottom = height};
            uint64_t total = (uint64_t) (width - 1) * height;
            uint64_t threshold = (4 * (total + 1) + 4) / 5;
            size_t bytes = (size_t) width * height * sizeof(uint32_t);
            uint32_t* pixels = malloc(bytes);
            uint32_t* original = malloc(bytes);
            CU_ASSERT_PTR_NOT_NULL_FATAL(pixels);
            CU_ASSERT_PTR_NOT_NULL_FATAL(original);
            for (int offset = -2; offset <= 2; offset++) {
                int64_t requested = (int64_t) threshold + offset;
                uint64_t same = requested < 0 ? 0 : (uint64_t) requested;
                if (same > total)
                    same = total;
                for (int arrangement = 0; arrangement < 3; arrangement++) {
                    classifier_fixture(pixels, width, height, same, arrangement);
                    memcpy(original, pixels, bytes);
                    int expected = classifier_full_scan((unsigned char*) pixels,
                            (size_t) width * sizeof(uint32_t), &rect);
                    CU_ASSERT_EQUAL(classifier_preference((unsigned char*) pixels,
                                (size_t) width * sizeof(uint32_t), &rect), expected);
                    CU_ASSERT_TRUE(classifier_comparisons <= total);
                    CU_ASSERT_EQUAL(memcmp(pixels, original, bytes), 0);
                }
            }
            free(original);
            free(pixels);
        }
    }
}

void test_display__image_classification_early_exit_counts() {
    enum { WIDTH = 257, HEIGHT = 100 };
    uint32_t* pixels = malloc(WIDTH * HEIGHT * sizeof(uint32_t));
    CU_ASSERT_PTR_NOT_NULL_FATAL(pixels);
    guac_rect rect = {.right = WIDTH, .bottom = HEIGHT};
    size_t stride = WIDTH * sizeof(uint32_t);
    uint64_t total = (WIDTH - 1) * HEIGHT;

    classifier_fixture(pixels, WIDTH, HEIGHT, 0, 0);
    CU_ASSERT_FALSE(classifier_preference((unsigned char*) pixels, stride, &rect));
    CU_ASSERT_EQUAL(classifier_rows, 20);
    CU_ASSERT_EQUAL(classifier_comparisons, total / 5);
    CU_ASSERT_EQUAL(classifier_full_scan((unsigned char*) pixels, stride, &rect), 0);

    classifier_fixture(pixels, WIDTH, HEIGHT, total, 0);
    CU_ASSERT_TRUE(classifier_preference((unsigned char*) pixels, stride, &rect));
    CU_ASSERT_EQUAL(classifier_rows, 81);
    CU_ASSERT_EQUAL(classifier_comparisons, (WIDTH - 1) * 81);
    CU_ASSERT_EQUAL(classifier_full_scan((unsigned char*) pixels, stride, &rect), 1);
    free(pixels);
}

void test_display__image_classification_empty_and_single_column() {
    const guac_rect empty[] = {
        {0, 0, 0, 10}, {4, 3, 4, 3}, {5, 5, 4, 8},
        {0, 9, 2, 8}, {INT_MAX, 0, INT_MIN, 4}
    };
    for (size_t i = 0; i < sizeof(empty) / sizeof(*empty); i++) {
        CU_ASSERT_TRUE(classifier_preference(NULL, 0, &empty[i]));
        CU_ASSERT_EQUAL(classifier_comparisons, 0);
        CU_ASSERT_EQUAL(classifier_rows, 0);
    }
    guac_rect column = {.left = 7, .top = 3, .right = 8, .bottom = 101};
    CU_ASSERT_FALSE(classifier_preference(NULL, 0, &column));
    CU_ASSERT_EQUAL(classifier_full_scan(NULL, 0, &column), 0);
    CU_ASSERT_EQUAL(classifier_comparisons, 0);
    CU_ASSERT_EQUAL(classifier_rows, 0);

    CU_ASSERT_EQUAL(image_format(NULL, 0, 10, 60, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
    uint32_t column_pixels[101] = {0};
#ifdef ENABLE_WEBP
    CU_ASSERT_EQUAL(image_format(column_pixels, 1, 101, 60, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_WEBP);
#else
    CU_ASSERT_EQUAL(image_format(column_pixels, 1, 101, 60, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
#endif
}

void test_display__image_classification_padded_bottom_subrectangle() {
    enum { WIDTH = 65, HEIGHT = 39, LEFT = 3, TOP = 2 };
    size_t stride = (LEFT + WIDTH + 7) * sizeof(uint32_t);
    /* The last source row ends exactly at the subrectangle's right edge. */
    size_t bytes = (TOP + HEIGHT - 1) * stride
        + (LEFT + WIDTH) * sizeof(uint32_t);
    unsigned char* pixels = malloc(bytes);
    unsigned char* original = malloc(bytes);
    uint32_t* tight = malloc(WIDTH * HEIGHT * sizeof(uint32_t));
    CU_ASSERT_PTR_NOT_NULL_FATAL(pixels);
    CU_ASSERT_PTR_NOT_NULL_FATAL(original);
    CU_ASSERT_PTR_NOT_NULL_FATAL(tight);
    guac_rect rect = {.left = LEFT, .top = TOP,
        .right = LEFT + WIDTH, .bottom = TOP + HEIGHT};
    uint64_t total = (WIDTH - 1) * HEIGHT;
    uint64_t threshold = (4 * (total + 1) + 4) / 5;
    for (int offset = -1; offset <= 1; offset++) {
        for (int arrangement = 0; arrangement < 3; arrangement++) {
            classifier_fixture(tight, WIDTH, HEIGHT, threshold + offset, arrangement);
            memset(pixels, 0xA5, bytes);
            for (int y = 0; y < HEIGHT; y++)
                memcpy(pixels + (TOP + y) * stride + LEFT * sizeof(uint32_t),
                        tight + y * WIDTH, WIDTH * sizeof(uint32_t));
            memcpy(original, pixels, bytes);
            CU_ASSERT_EQUAL(classifier_preference(pixels, stride, &rect),
                    classifier_full_scan(pixels, stride, &rect));
            CU_ASSERT_EQUAL(memcmp(pixels, original, bytes), 0);
        }
    }
    free(tight);
    free(original);
    free(pixels);
}

void test_display__image_classification_large_repetition_avoids_score_overflow() {
    /* The old int expression 256 * same overflowed above 8,388,607 equal
     * pairs, even though the display supports regions this large. */
    enum { WIDTH = 4097, HEIGHT = 2050 };
    size_t bytes = (size_t) WIDTH * HEIGHT * sizeof(uint32_t);
    uint32_t* pixels = calloc(1, bytes);
    CU_ASSERT_PTR_NOT_NULL_FATAL(pixels);
    guac_rect rect = {.right = WIDTH, .bottom = HEIGHT};
    size_t stride = WIDTH * sizeof(uint32_t);
    CU_ASSERT_TRUE(classifier_full_scan((unsigned char*) pixels, stride, &rect));
    CU_ASSERT_TRUE(classifier_preference((unsigned char*) pixels, stride, &rect));
    CU_ASSERT_TRUE(classifier_comparisons < (uint64_t) (WIDTH - 1) * HEIGHT);
    CU_ASSERT_EQUAL(image_format(pixels, WIDTH, HEIGHT, 60, 1, 0, 1),
            GUAC_DISPLAY_IMAGE_FORMAT_PNG);
    free(pixels);
}
