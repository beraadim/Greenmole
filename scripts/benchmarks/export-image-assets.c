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

/* Export synthetic assets through the real PNG/WebP encoders. Timings here
 * describe one sequential encode only; matched production benchmarks are the
 * performance evidence. The blob hook retains encoded bytes for local replay,
 * while the real protocol writer still serializes each blob to a discard sink. */
#ifdef BENCH_PNG_COMPRESSION_CONTROL
#include "png-compression-control.h"
#endif
#include "encode-png.h"
#include "encode-webp.h"
#include "guacamole/protocol.h"
#include "guacamole/socket.h"
#include "guacamole/stream.h"
#include <cairo/cairo.h>
#include <dlfcn.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <webp/decode.h>

#define ASSET_LIMIT (32U * 1024U * 1024U)
static unsigned char* encoded;
static size_t encoded_size, encoded_capacity;
static int (*send_blob)(guac_socket*, const guac_stream*, const void*, int);

static void fail(const char* message) {
    fprintf(stderr, "%s\n", message);
    exit(1);
}

int guac_protocol_send_blob(guac_socket* socket, const guac_stream* stream,
        const void* data, int length) {
    if (length < 0 || (size_t) length > ASSET_LIMIT - encoded_size)
        fail("Encoded asset exceeds its bound.");
    size_t required = encoded_size + (size_t) length;
    if (required > encoded_capacity) {
        size_t capacity = encoded_capacity ? encoded_capacity : 4096;
        while (capacity < required) capacity *= 2;
        unsigned char* replacement = realloc(encoded, capacity);
        if (!replacement) fail("Encoded asset allocation failed.");
        encoded = replacement;
        encoded_capacity = capacity;
    }
    memcpy(encoded + encoded_size, data, (size_t) length);
    encoded_size = required;
    return send_blob(socket, stream, data, length);
}

static uint64_t now_ns(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) fail("Clock failed.");
    return (uint64_t) ts.tv_sec * UINT64_C(1000000000) + (uint64_t) ts.tv_nsec;
}

typedef struct png_input { size_t offset; } png_input;
static cairo_status_t read_png(void* closure, unsigned char* data, unsigned int n) {
    png_input* input = closure;
    if (input->offset > encoded_size || n > encoded_size - input->offset)
        return CAIRO_STATUS_READ_ERROR;
    memcpy(data, encoded + input->offset, n);
    input->offset += n;
    return CAIRO_STATUS_SUCCESS;
}

static uint32_t pixel(int x, int y, int variant, int tile, int photographic) {
    if (photographic) {
        uint32_t noise = (uint32_t) x * UINT32_C(0x45d9f3b)
            ^ (uint32_t) y * UINT32_C(0x27d4eb2d)
            ^ (uint32_t) (variant * 31 + tile * 17);
        noise ^= noise >> 16;
        unsigned int r = (unsigned int) (x / 8 + y / 16 + variant * 29 + tile * 11) & 255U;
        unsigned int g = (unsigned int) (y / 4 + x / 32 + variant * 13 + tile * 7) & 255U;
        unsigned int b = (unsigned int) (x / 16 + y / 8 + variant * 19 + tile * 3) & 255U;
        return ((r ^ (noise & 15U)) << 16) | ((g ^ ((noise >> 4) & 15U)) << 8)
            | (b ^ ((noise >> 8) & 15U));
    }
    unsigned int color = 2;
    if (y % 24 >= 6 && y % 24 < 18 && x % 9 < 6)
        color = ((unsigned int) (x / 9 + y / 24 + tile + variant) % 14U) + 2U;
    if ((x / 100 + variant + tile) % 5 == 0 && y % 96 < 4) color = 15;
    unsigned int c = color * 17U;
    return (c << 16) | (c << 8) | c;
}

static void export_asset(guac_socket* socket, guac_stream* stream,
        int photographic, int full, int variant, int tile) {
    int width = full ? 1920 : 128, height = full ? 944 : 96;
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_RGB24, width, height);
    if (cairo_surface_status(surface)) fail("Source allocation failed.");
    unsigned char* data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    uint64_t source_hash = UINT64_C(14695981039346656037);
    for (int y = 0; y < height; y++) {
        uint32_t* row = (uint32_t*) (data + (size_t) y * stride);
        for (int x = 0; x < width; x++) {
            uint32_t value = pixel(x, y, variant, tile, photographic);
            row[x] = value;
            for (int shift = 16; shift >= 0; shift -= 8) {
                source_hash ^= (value >> shift) & 255U;
                source_hash *= UINT64_C(1099511628211);
            }
        }
    }
    cairo_surface_mark_dirty(surface);
    encoded_size = 0;
    uint64_t started = now_ns();
    int status = photographic ? guac_webp_write(socket, stream, surface, 90, 0)
        : guac_png_write(socket, stream, surface);
    double elapsed = (now_ns() - started) / 1000000.0;
    if (status || !encoded_size) fail("Production encoder failed.");
    for (int y = 0; y < height; y++) {
        const uint32_t* row = (const uint32_t*) (data + (size_t) y * stride);
        for (int x = 0; x < width; x++)
            if (row[x] != pixel(x, y, variant, tile, photographic))
                fail("Production encoder changed source pixels.");
    }
    int decoded_width = 0, decoded_height = 0;
    if (photographic) {
        if (!WebPGetInfo(encoded, encoded_size, &decoded_width, &decoded_height)
                || decoded_width != width || decoded_height != height)
            fail("WebP asset geometry invalid.");
    }
    else {
        png_input input = {0};
        cairo_surface_t* decoded = cairo_image_surface_create_from_png_stream(read_png, &input);
        if (cairo_surface_status(decoded) || cairo_image_surface_get_width(decoded) != width
                || cairo_image_surface_get_height(decoded) != height)
            fail("PNG asset decode failed.");
        cairo_surface_flush(decoded);
        unsigned char* decoded_data = cairo_image_surface_get_data(decoded);
        int decoded_stride = cairo_image_surface_get_stride(decoded);
        for (int y = 0; y < height; y++) {
            const uint32_t* check = (const uint32_t*) (decoded_data + (size_t) y * decoded_stride);
            for (int x = 0; x < width; x++)
                if ((check[x] & UINT32_C(0xffffff)) != pixel(x, y, variant, tile, 0))
                    fail("PNG pixels differ from source.");
        }
        cairo_surface_destroy(decoded);
    }
    printf("{\"id\":\"%s-%s-v%d-t%d\",\"mimetype\":\"image/%s\","
            "\"width\":%d,\"height\":%d,\"bytes\":%zu,\"encode_ms\":%.6f,"
            "\"source_rgb_fnv1a64\":\"%016" PRIx64 "\",\"png_source_pixels_verified\":%s}\n",
            photographic ? "webp" : "png", full ? "full" : "tile", variant, tile,
            photographic ? "webp" : "png", width, height, encoded_size, elapsed,
            source_hash, photographic ? "false" : "true");
    if (fwrite(encoded, 1, encoded_size, stdout) != encoded_size || putchar('\n') == EOF)
        fail("Asset output failed.");
    cairo_surface_destroy(surface);
}

int main(int argc, char** argv) {
#ifdef BENCH_PNG_COMPRESSION_CONTROL
    if (argc != 4 || !benchmark_png_control_initialize(argv[1], argv[2], argv[3]))
        fail("Invalid PNG study control.");
    benchmark_png_statistics before = benchmark_png_control_snapshot();
#else
    (void) argc;
    (void) argv;
#endif
    union { void* pointer; int (*function)(guac_socket*, const guac_stream*, const void*, int); } resolved;
    resolved.pointer = dlsym(RTLD_NEXT, "guac_protocol_send_blob");
    if (!resolved.pointer) fail("Real blob writer unavailable.");
    send_blob = resolved.function;
    guac_socket* socket = guac_socket_alloc();
    if (!socket) fail("Socket allocation failed.");
    guac_stream stream = { .index = 0 };
    for (int codec = 0; codec < 2; codec++) {
        for (int variant = 0; variant < 2; variant++) {
            export_asset(socket, &stream, codec, 1, variant, 0);
            for (int tile = 0; tile < 4; tile++)
                export_asset(socket, &stream, codec, 0, variant, tile);
        }
    }
#ifdef BENCH_PNG_COMPRESSION_CONTROL
    benchmark_png_statistics after = benchmark_png_control_snapshot();
    if (after.indexed_calls - before.indexed_calls != 10)
        fail("PNG study hook did not observe every asset.");
    benchmark_png_control_json(stderr, &before, &after);
    fputc('\n', stderr);
#endif
    guac_socket_free(socket);
    free(encoded);
    return ferror(stdout) ? 1 : 0;
}
