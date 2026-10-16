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
#include "../../encode-webp.h"

#include <CUnit/CUnit.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <webp/decode.h>
#include <webp/encode.h>

static pthread_mutex_t webp_test_allocator_lock = PTHREAD_MUTEX_INITIALIZER;
static int webp_test_fail_growth;
static int webp_test_fail_picture;
static int webp_test_fail_encode;
static unsigned int webp_test_growth_calls;
static unsigned int webp_test_picture_calls;

static void* webp_test_realloc(void* data, size_t size) {
    pthread_mutex_lock(&webp_test_allocator_lock);
    webp_test_growth_calls++;
    int fail = webp_test_fail_growth;
    pthread_mutex_unlock(&webp_test_allocator_lock);
    return fail ? NULL : realloc(data, size);
}

static int webp_test_picture_alloc(WebPPicture* picture) {
    pthread_mutex_lock(&webp_test_allocator_lock);
    webp_test_picture_calls++;
    int fail = webp_test_fail_picture;
    pthread_mutex_unlock(&webp_test_allocator_lock);
    return fail ? 0 : WebPPictureAlloc(picture);
}

static int webp_test_encode(const WebPConfig* config, WebPPicture* picture) {
    return webp_test_fail_encode ? 0 : WebPEncode(config, picture);
}

static int webp_test_blob(guac_display_render_sample* sample, guac_socket* socket,
        guac_stream* stream, const void* data, int length);

/* Exercise a private copy of the real writer with isolated fault injection;
 * all successful compression and decoding still use the actual libwebp. */
#define guac_webp_write webp_test_write
#define guac_webp_set_workspace webp_test_set_workspace
#define guac_webp_workspace_free webp_test_workspace_free
#define guac_display_diagnostics_send_blob webp_test_blob
#define realloc webp_test_realloc
#define WebPPictureAlloc webp_test_picture_alloc
#define WebPEncode webp_test_encode
#include "../../encode-webp.c"
#undef WebPEncode
#undef WebPPictureAlloc
#undef realloc
#undef guac_display_diagnostics_send_blob
#undef guac_webp_workspace_free
#undef guac_webp_set_workspace
#undef guac_webp_write

typedef struct webp_test_output {
    unsigned char* bytes;
    size_t length;
    cairo_surface_t* nested_surface;
    struct webp_test_output* nested_output;
    int nested_called;
    int nested_status;
} webp_test_output;

static int webp_test_blob(guac_display_render_sample* sample, guac_socket* socket,
        guac_stream* stream, const void* data, int length) {
    (void) sample;
    webp_test_output* output = socket->data;
    if (length < 0) return -1;
    if (length) {
        unsigned char* bytes = realloc(output->bytes, output->length + (size_t) length);
        if (bytes == NULL) return -1;
        output->bytes = bytes;
        memcpy(bytes + output->length, data, (size_t) length);
        output->length += (size_t) length;
    }
    if (output->nested_surface && !output->nested_called) {
        output->nested_called = 1;
        guac_socket nested_socket = { .data = output->nested_output };
        output->nested_status = webp_test_write(&nested_socket, stream,
                output->nested_surface, 75, 1);
    }
    return 0;
}

static uint32_t webp_test_pixel(int x, int y, int argb) {
    unsigned int alpha = argb ? (unsigned int) (x * 13 + y * 7) & 255U : 255U;
    unsigned int red = ((unsigned int) (x * 17 + y * 11) & 255U) * alpha / 255U;
    unsigned int green = ((unsigned int) (x * 31 + y * 3) & 255U) * alpha / 255U;
    unsigned int blue = ((unsigned int) (x * 5 + y * 29) & 255U) * alpha / 255U;
    /* RGB24's unused byte is intentionally neither zero nor always opaque. */
    return (argb ? alpha : (unsigned int) (x + y) & 255U) << 24
        | red << 16 | green << 8 | blue;
}

static cairo_surface_t* webp_test_surface(int width, int height, int argb,
        unsigned char** data, int* stride) {
    *stride = (width + 11) * 4;
    *data = malloc((size_t) *stride * height);
    if (!*data) return NULL;
    memset(*data, 0xA5, (size_t) *stride * height);
    for (int y = 0; y < height; y++) {
        uint32_t* row = (uint32_t*) (*data + (size_t) y * *stride);
        for (int x = 0; x < width; x++) row[x] = webp_test_pixel(x, y, argb);
    }
    return cairo_image_surface_create_for_data(*data,
            argb ? CAIRO_FORMAT_ARGB32 : CAIRO_FORMAT_RGB24, width, height, *stride);
}

static void webp_test_release_picture(WebPPicture* picture, guac_webp_workspace* acquired) {
    WebPPictureFree(picture);
    if (acquired) acquired->in_use = 0;
}

/** Reused packed input matches legacy allocation/copy across changing rows. */
void test_encode__webp_preparation_preserves_stride_alpha_and_source() {
    guac_webp_workspace workspace = { 0 };
    for (int argb = 0; argb < 2; argb++) {
        for (int iteration = 0; iteration < 3; iteration++) {
            int width = iteration == 0 ? 97 : iteration == 1 ? 13 : 129;
            int height = iteration == 0 ? 53 : iteration == 1 ? 17 : 65;
            unsigned char* data; int stride;
            cairo_surface_t* surface = webp_test_surface(width, height, argb, &data, &stride);
            CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
            size_t size = (size_t) stride * height;
            unsigned char* before = malloc(size);
            CU_ASSERT_PTR_NOT_NULL_FATAL(before);
            memcpy(before, data, size);
            WebPPicture legacy, reused;
            CU_ASSERT_TRUE_FATAL(WebPPictureInit(&legacy));
            CU_ASSERT_TRUE_FATAL(WebPPictureInit(&reused));
            guac_webp_workspace* acquired;
            CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&legacy, surface, NULL, &acquired));
            CU_ASSERT_PTR_NULL(acquired);
            CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&reused, surface, &workspace, &acquired));
            CU_ASSERT_PTR_EQUAL(acquired, &workspace);
            for (int y = 0; y < height; y++) {
                CU_ASSERT_EQUAL(memcmp(legacy.argb + (size_t) y * legacy.argb_stride,
                            reused.argb + (size_t) y * reused.argb_stride, (size_t) width * 4), 0);
                for (int x = 0; x < width; x++)
                    CU_ASSERT_EQUAL(reused.argb[(size_t) y * reused.argb_stride + x],
                            webp_test_pixel(x, y, argb) | (argb ? 0U : UINT32_C(0xFF000000)));
            }
            CU_ASSERT_EQUAL(memcmp(before, data, size), 0);
            webp_test_release_picture(&legacy, NULL);
            webp_test_release_picture(&reused, acquired);
            cairo_surface_destroy(surface); free(before); free(data);
        }
    }
    webp_test_workspace_free(&workspace);
    CU_ASSERT_PTR_NULL(workspace.argb);
    CU_ASSERT_EQUAL(workspace.capacity_pixels, 0);
    CU_ASSERT_FALSE(workspace.in_use);
}

/** Subrectangles reaching the backing bottom and negative strides stay valid. */
void test_encode__webp_subrectangle_and_negative_stride_preserve_rows() {
    const int stride = 96 * 4;
    unsigned char* backing = malloc((size_t) stride * 80);
    unsigned char* before = malloc((size_t) stride * 80);
    CU_ASSERT_PTR_NOT_NULL_FATAL(backing); CU_ASSERT_PTR_NOT_NULL_FATAL(before);
    for (int argb = 0; argb < 2; argb++) {
        for (int y = 0; y < 80; y++) {
            uint32_t* row = (uint32_t*) (backing + (size_t) y * stride);
            for (int x = 0; x < 96; x++) row[x] = webp_test_pixel(x, y, argb);
        }
        memcpy(before, backing, (size_t) stride * 80);
        for (int reversed = 0; reversed < 2; reversed++) {
            int row_stride = reversed ? -stride : stride;
            unsigned char* first_row = backing + (size_t) (reversed ? 79 : 16) * stride + 17 * 4;
            cairo_surface_t* surface = cairo_image_surface_create_for_data(first_row,
                    argb ? CAIRO_FORMAT_ARGB32 : CAIRO_FORMAT_RGB24, 64, 64, row_stride);
            CU_ASSERT_EQUAL_FATAL(cairo_surface_status(surface), CAIRO_STATUS_SUCCESS);
            guac_webp_workspace workspace = { 0 };
            WebPPicture picture; guac_webp_workspace* acquired;
            CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
            CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&picture, surface, &workspace, &acquired));
            for (int y = 0; y < 64; y++) {
                const uint32_t* row = (const uint32_t*) (first_row + (ptrdiff_t) y * row_stride);
                for (int x = 0; x < 64; x++)
                    CU_ASSERT_EQUAL(picture.argb[(size_t) y * picture.argb_stride + x],
                            row[x] | (argb ? 0U : UINT32_C(0xFF000000)));
            }
            webp_test_release_picture(&picture, acquired);
            webp_test_output legacy = { 0 }, reused = { 0 };
            guac_socket socket = { .data = &legacy }; guac_stream stream = { 0 };
            webp_test_set_workspace(NULL);
            CU_ASSERT_EQUAL_FATAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
            webp_test_set_workspace(&workspace); socket.data = &reused;
            CU_ASSERT_EQUAL_FATAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
            webp_test_set_workspace(NULL);
            CU_ASSERT_EQUAL_FATAL(legacy.length, reused.length);
            CU_ASSERT_EQUAL(memcmp(legacy.bytes, reused.bytes, legacy.length), 0);
            CU_ASSERT_EQUAL(memcmp(backing, before, (size_t) stride * 80), 0);
            free(legacy.bytes); free(reused.bytes);
            cairo_surface_destroy(surface); webp_test_workspace_free(&workspace);
        }
    }
    free(backing); free(before);
}

/** Real lossless decode and complete payload bytes match transient encoding. */
void test_encode__webp_workspace_preserves_payload_and_decoded_pixels() {
    guac_webp_workspace workspace = { 0 };
    for (int argb = 0; argb < 2; argb++) {
        unsigned char* data; int stride;
        cairo_surface_t* surface = webp_test_surface(97, 53, argb, &data, &stride);
        CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
        unsigned char before[108 * 4 * 53];
        memcpy(before, data, sizeof(before));
        for (int lossless = 0; lossless < 2; lossless++) {
            for (int q = 0; q < 3; q++) {
                int quality = q == 0 ? 0 : q == 1 ? 75 : 100;
                webp_test_output legacy = { 0 }, reused = { 0 };
                guac_socket socket = { .data = &legacy };
                guac_stream stream = { 0 };
                webp_test_set_workspace(NULL);
                CU_ASSERT_EQUAL_FATAL(webp_test_write(&socket, &stream, surface, quality, lossless), 0);
                socket.data = &reused;
                webp_test_set_workspace(&workspace);
                CU_ASSERT_EQUAL_FATAL(webp_test_write(&socket, &stream, surface, quality, lossless), 0);
                webp_test_set_workspace(NULL);
                CU_ASSERT_EQUAL_FATAL(legacy.length, reused.length);
                CU_ASSERT_EQUAL(memcmp(legacy.bytes, reused.bytes, legacy.length), 0);
                CU_ASSERT_FALSE(workspace.in_use);
                if (lossless) {
                    int width, height;
                    unsigned char* rgba = WebPDecodeRGBA(reused.bytes, reused.length, &width, &height);
                    CU_ASSERT_PTR_NOT_NULL_FATAL(rgba);
                    CU_ASSERT_EQUAL(width, 97); CU_ASSERT_EQUAL(height, 53);
                    for (int y = 0; y < height; y++) {
                        for (int x = 0; x < width; x++) {
                            uint32_t expected = webp_test_pixel(x, y, argb) | (argb ? 0U : UINT32_C(0xFF000000));
                            unsigned char* pixel = rgba + ((size_t) y * width + x) * 4;
                            /* The unchanged default exact=0 may rewrite RGB
                             * beneath fully transparent alpha. Payloads still
                             * match legacy byte-for-byte above. */
                            if (expected >> 24) {
                                CU_ASSERT_EQUAL(pixel[0], (expected >> 16) & 255U);
                                CU_ASSERT_EQUAL(pixel[1], (expected >> 8) & 255U);
                                CU_ASSERT_EQUAL(pixel[2], expected & 255U);
                            }
                            CU_ASSERT_EQUAL(pixel[3], expected >> 24);
                        }
                    }
                    WebPFree(rgba);
                }
                CU_ASSERT_EQUAL(memcmp(before, data, sizeof(before)), 0);
                free(legacy.bytes); free(reused.bytes);
            }
        }
        cairo_surface_destroy(surface); free(data);
    }
    webp_test_workspace_free(&workspace);
}

/** The strict retention boundary never grows for larger or nested requests. */
void test_encode__webp_workspace_bounds_oversized_and_nested_preparation() {
    guac_webp_workspace workspace = { 0 };
    unsigned char* data; int stride;
    int bound_width = GUAC_WEBP_WORKSPACE_MAX_BYTES / (512 * (int) sizeof(uint32_t));
    cairo_surface_t* surface = webp_test_surface(bound_width, 512, 0, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    WebPPicture picture;
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    guac_webp_workspace* acquired;
    CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&picture, surface, &workspace, &acquired));
    CU_ASSERT_EQUAL(workspace.capacity_pixels * sizeof(uint32_t), GUAC_WEBP_WORKSPACE_MAX_BYTES);
    uint32_t* original = workspace.argb;
    webp_test_release_picture(&picture, acquired);
    cairo_surface_destroy(surface); free(data);

    surface = webp_test_surface(bound_width + 1, 512, 0, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    unsigned int allocations = webp_test_picture_calls;
    CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&picture, surface, &workspace, &acquired));
    CU_ASSERT_PTR_NULL(acquired);
    CU_ASSERT_EQUAL(webp_test_picture_calls, allocations + 1);
    CU_ASSERT_PTR_EQUAL(workspace.argb, original);
    webp_test_release_picture(&picture, NULL);
    cairo_surface_destroy(surface); free(data);

    surface = webp_test_surface(17, 9, 1, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    workspace.in_use = 1;
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&picture, surface, &workspace, &acquired));
    CU_ASSERT_PTR_NULL(acquired);
    CU_ASSERT_PTR_NOT_EQUAL(picture.argb, workspace.argb);
    webp_test_release_picture(&picture, NULL);
    CU_ASSERT_TRUE(workspace.in_use);
    workspace.in_use = 0;
    cairo_surface_destroy(surface); free(data);
    webp_test_workspace_free(&workspace);
}

/** Failed growth preserves the old cache, releases ownership, and can retry. */
void test_encode__webp_failed_growth_preserves_workspace() {
    guac_webp_workspace workspace = { 0 };
    unsigned char* data; int stride;
    cairo_surface_t* surface = webp_test_surface(16, 16, 0, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    WebPPicture picture; guac_webp_workspace* acquired;
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    CU_ASSERT_TRUE_FATAL(guac_webp_prepare_picture(&picture, surface, &workspace, &acquired));
    webp_test_release_picture(&picture, acquired);
    cairo_surface_destroy(surface); free(data);
    uint32_t* original = workspace.argb;
    size_t capacity = workspace.capacity_pixels;
    surface = webp_test_surface(128, 65, 0, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    webp_test_fail_growth = 1;
    int prepared = guac_webp_prepare_picture(&picture, surface, &workspace, &acquired);
    webp_test_fail_growth = 0;
    CU_ASSERT_TRUE(prepared);
    CU_ASSERT_PTR_NULL(acquired);
    CU_ASSERT_PTR_EQUAL(workspace.argb, original);
    CU_ASSERT_EQUAL(workspace.capacity_pixels, capacity);
    CU_ASSERT_FALSE(workspace.in_use);
    webp_test_release_picture(&picture, NULL);
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    webp_test_fail_growth = webp_test_fail_picture = 1;
    prepared = guac_webp_prepare_picture(&picture, surface, &workspace, &acquired);
    webp_test_fail_growth = webp_test_fail_picture = 0;
    CU_ASSERT_FALSE(prepared);
    CU_ASSERT_PTR_NULL(acquired);
    CU_ASSERT_PTR_EQUAL(workspace.argb, original);
    CU_ASSERT_EQUAL(workspace.capacity_pixels, capacity);
    CU_ASSERT_FALSE(workspace.in_use);
    WebPPictureFree(&picture);
    CU_ASSERT_TRUE_FATAL(WebPPictureInit(&picture));
    CU_ASSERT_TRUE(guac_webp_prepare_picture(&picture, surface, &workspace, &acquired));
    webp_test_release_picture(&picture, acquired);
    cairo_surface_destroy(surface); free(data);
    webp_test_workspace_free(&workspace);
}

/** Encoder or transient allocation failure cannot strand an acquired cache. */
void test_encode__webp_failures_release_workspace_for_following_images() {
    guac_webp_workspace workspace = { 0 };
    unsigned char* data; int stride;
    cairo_surface_t* surface = webp_test_surface(17, 9, 0, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    webp_test_output output = { 0 };
    guac_socket socket = { .data = &output }; guac_stream stream = { 0 };
    webp_test_set_workspace(&workspace);
    webp_test_fail_encode = 1;
    int status = webp_test_write(&socket, &stream, surface, 75, 1);
    webp_test_fail_encode = 0;
    CU_ASSERT_EQUAL(status, -1);
    CU_ASSERT_FALSE(workspace.in_use);
    CU_ASSERT_EQUAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
    webp_test_set_workspace(NULL);
    webp_test_fail_picture = 1;
    status = webp_test_write(&socket, &stream, surface, 75, 1);
    webp_test_fail_picture = 0;
    CU_ASSERT_EQUAL(status, -1);
    CU_ASSERT_FALSE(workspace.in_use);
    free(output.bytes);
    cairo_surface_destroy(surface); free(data);
    webp_test_workspace_free(&workspace);
}

/** Real writer reentrancy uses a transient picture while the cache is busy. */
void test_encode__webp_nested_encoder_uses_independent_input() {
    guac_webp_workspace workspace = { 0 };
    unsigned char *data, *nested_data; int stride, nested_stride;
    cairo_surface_t* surface = webp_test_surface(64, 35, 0, &data, &stride);
    cairo_surface_t* nested_surface = webp_test_surface(17, 9, 1, &nested_data, &nested_stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface); CU_ASSERT_PTR_NOT_NULL_FATAL(nested_surface);
    webp_test_output expected = { 0 }, nested = { 0 };
    webp_test_output actual = { .nested_surface = nested_surface, .nested_output = &nested };
    guac_socket socket = { .data = &expected }; guac_stream stream = { 0 };
    webp_test_set_workspace(NULL);
    CU_ASSERT_EQUAL_FATAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
    socket.data = &actual;
    unsigned int allocations = webp_test_picture_calls;
    webp_test_set_workspace(&workspace);
    CU_ASSERT_EQUAL_FATAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
    webp_test_set_workspace(NULL);
    CU_ASSERT_TRUE(actual.nested_called);
    CU_ASSERT_EQUAL(actual.nested_status, 0);
#ifdef GUAC_THREAD_LOCAL
    CU_ASSERT_EQUAL(webp_test_picture_calls, allocations + 1);
#else
    CU_ASSERT_EQUAL(webp_test_picture_calls, allocations + 2);
#endif
    CU_ASSERT_EQUAL_FATAL(expected.length, actual.length);
    CU_ASSERT_EQUAL(memcmp(expected.bytes, actual.bytes, expected.length), 0);
    CU_ASSERT_FALSE(workspace.in_use);
    free(expected.bytes); free(actual.bytes); free(nested.bytes);
    cairo_surface_destroy(surface); cairo_surface_destroy(nested_surface);
    free(data); free(nested_data); webp_test_workspace_free(&workspace);
}

/** Invalid input fails before cache acquisition or source modification. */
void test_encode__webp_invalid_surface_does_not_acquire_workspace() {
    guac_webp_workspace workspace = { 0 };
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_A8, 8, 8);
    webp_test_output output = { 0 };
    guac_socket socket = { .data = &output }; guac_stream stream = { 0 };
    webp_test_set_workspace(&workspace);
    CU_ASSERT_EQUAL(webp_test_write(&socket, &stream, surface, 75, 1), -1);
    webp_test_set_workspace(NULL);
    CU_ASSERT_FALSE(workspace.in_use);
    CU_ASSERT_PTR_NULL(workspace.argb);
    CU_ASSERT_EQUAL(output.length, 0);
    cairo_surface_destroy(surface); webp_test_workspace_free(&workspace);
}

/** Scoped replacement restores A after B without mixing either input buffer. */
void test_encode__webp_workspace_binding_restores_previous_scope() {
    guac_webp_workspace first = { 0 }, second = { 0 };
    guac_webp_workspace* initial = webp_test_set_workspace(&first);
    CU_ASSERT_PTR_NULL(initial);
    guac_webp_workspace* preceding = webp_test_set_workspace(&second);
#ifdef GUAC_THREAD_LOCAL
    CU_ASSERT_PTR_EQUAL(preceding, &first);
    CU_ASSERT_PTR_EQUAL(webp_test_set_workspace(preceding), &second);
#else
    CU_ASSERT_PTR_NULL(preceding);
    CU_ASSERT_PTR_NULL(webp_test_set_workspace(preceding));
#endif
    unsigned char* data; int stride;
    cairo_surface_t* surface = webp_test_surface(17, 9, 0, &data, &stride);
    CU_ASSERT_PTR_NOT_NULL_FATAL(surface);
    webp_test_output output = { 0 };
    guac_socket socket = { .data = &output }; guac_stream stream = { 0 };
    CU_ASSERT_EQUAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
    uint32_t* first_pixels = first.argb;
    preceding = webp_test_set_workspace(&second);
    CU_ASSERT_EQUAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
    webp_test_set_workspace(preceding);
    CU_ASSERT_EQUAL(webp_test_write(&socket, &stream, surface, 75, 1), 0);
#ifdef GUAC_THREAD_LOCAL
    CU_ASSERT_PTR_NOT_NULL_FATAL(first_pixels);
    CU_ASSERT_PTR_NOT_EQUAL(first_pixels, second.argb);
    CU_ASSERT_PTR_EQUAL(first.argb, first_pixels);
#else
    CU_ASSERT_PTR_NULL(first_pixels); CU_ASSERT_PTR_NULL(second.argb);
#endif
    webp_test_set_workspace(initial);
    webp_test_workspace_free(&first); webp_test_workspace_free(&second);
    cairo_surface_destroy(surface); free(data); free(output.bytes);
}

static void* webp_test_worker(void* opaque) {
    int* result = opaque;
    *result = 0;
    guac_webp_workspace workspace = { 0 };
    guac_webp_workspace* previous = webp_test_set_workspace(&workspace);
    unsigned char* data; int stride;
    cairo_surface_t* surface = webp_test_surface(31, 19, 0, &data, &stride);
    webp_test_output output = { 0 };
    guac_socket socket = { .data = &output }; guac_stream stream = { 0 };
    if (!surface || webp_test_write(&socket, &stream, surface, 75, 1) != 0) goto done;
#ifdef GUAC_THREAD_LOCAL
    if (previous != NULL || workspace.argb == NULL || workspace.in_use) goto done;
#else
    if (previous != NULL || workspace.argb != NULL || workspace.in_use) goto done;
#endif
    *result = 1;
done:
    webp_test_set_workspace(previous);
    webp_test_workspace_free(&workspace);
    if (workspace.argb || workspace.capacity_pixels || workspace.in_use) *result = 0;
    if (surface) cairo_surface_destroy(surface);
    free(data); free(output.bytes);
    return NULL;
}

/** Per-thread binding and exit cleanup work for compiler and fallback paths. */
void test_encode__webp_worker_bindings_are_isolated_and_released() {
    pthread_t first, second;
    int first_result = 0, second_result = 0;
    int first_error = pthread_create(&first, NULL, webp_test_worker, &first_result);
    int second_error = pthread_create(&second, NULL, webp_test_worker, &second_result);
    CU_ASSERT_EQUAL(first_error, 0); CU_ASSERT_EQUAL(second_error, 0);
    if (!first_error) pthread_join(first, NULL);
    if (!second_error) pthread_join(second, NULL);
    CU_ASSERT_TRUE(first_result); CU_ASSERT_TRUE(second_result);
}
