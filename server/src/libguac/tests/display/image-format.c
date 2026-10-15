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
