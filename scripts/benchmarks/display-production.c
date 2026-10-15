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

/* Production-path benchmark: real display planning, copy search, FIFO, worker
 * admission, codecs, sync and serialization to a shared discard socket. */
#include "display-priv.h"
#include "guacamole/client.h"
#include "guacamole/display.h"
#include "guacamole/fifo.h"
#include "guacamole/protocol.h"
#include "guacamole/socket.h"

#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <webp/decode.h>
#include <pthread.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* This verifier is deliberately separate from measured rendering. It reads
 * serialized length-prefixed instructions, reconstructs opaque fixture layers
 * with Cairo, and decodes actual PNG/lossless WebP streams. Only synthetic
 * pixels are examined; nothing is saved. Unsupported instructions fail closed.
 * It is a fixture validator, not a general Guacamole browser implementation. */
#define VERIFY_LAYERS 8
#define VERIFY_STREAMS 128
#define VERIFY_IMAGE_LIMIT (64U * 1024U * 1024U)

typedef struct verify_layer {
    int used, index;
    cairo_surface_t* surface;
    int x, y, width, height;
} verify_layer;
typedef struct verify_stream {
    int active, layer, x, y, mode, webp;
    unsigned char* data;
    size_t length, capacity, offset;
} verify_stream;
typedef struct verifier {
    int width, height, failed, state, digits, argc;
    size_t remaining, declared, used;
    char values[32768];
    char* argv[128];
    verify_layer layers[VERIFY_LAYERS];
    verify_stream streams[VERIFY_STREAMS];
    uint64_t instructions, syncs, images, copies, fills;
} verifier;

static int integer(const char* text) {
    char* end;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || *end || end == text || value < INT_MIN || value > INT_MAX) {
        fprintf(stderr, "Invalid fixture protocol integer.\n"); exit(1);
    }
    return (int) value;
}

static verify_layer* verify_get_layer(verifier* v, int index) {
    verify_layer* vacant = NULL;
    for (int i = 0; i < VERIFY_LAYERS; i++) {
        if (v->layers[i].used && v->layers[i].index == index) return &v->layers[i];
        if (!v->layers[i].used) vacant = &v->layers[i];
    }
    if (!vacant) { v->failed = 1; return NULL; }
    vacant->used = 1;
    vacant->index = index;
    /* Fixture backing buffers grow implicitly in the browser. Giving them the
     * known fixture bounds up front has the same transparent initial pixels. */
    vacant->surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, v->width, v->height);
    if (cairo_surface_status(vacant->surface)) { v->failed = 1; return NULL; }
    return vacant;
}

static int verify_bounds(verifier* v, int x, int y, int width, int height) {
    return x >= 0 && y >= 0 && width >= 0 && height >= 0
        && width <= v->width && height <= v->height
        && x <= v->width - width && y <= v->height - height;
}

static cairo_operator_t verify_operator(int mode) {
    switch (mode) {
        case GUAC_COMP_OVER: return CAIRO_OPERATOR_OVER;
        case GUAC_COMP_SRC: return CAIRO_OPERATOR_SOURCE;
        case GUAC_COMP_ROUT: return CAIRO_OPERATOR_DEST_OUT;
        case GUAC_COMP_RATOP: return CAIRO_OPERATOR_DEST_ATOP;
        default: fprintf(stderr, "Unsupported fixture composite mode.\n"); exit(1);
    }
}

static cairo_status_t verify_read_png(void* closure, unsigned char* data, unsigned int count) {
    verify_stream* stream = closure;
    if (count > stream->length - stream->offset) return CAIRO_STATUS_READ_ERROR;
    memcpy(data, stream->data + stream->offset, count);
    stream->offset += count;
    return CAIRO_STATUS_SUCCESS;
}

static void verify_instruction(verifier* v) {
    char** a = v->argv;
    int n = v->argc;
    v->instructions++;
    if (!strcmp(a[0], "sync") && (n == 2 || n == 3)) { v->syncs++; return; }
    if ((!strcmp(a[0], "move") && n == 6) || (!strcmp(a[0], "shade") && n == 3)
            || (!strcmp(a[0], "cursor") && n == 8)) return;
    if (!strcmp(a[0], "size") && n == 4) {
        int width = integer(a[2]), height = integer(a[3]);
        if (!verify_bounds(v, 0, 0, width, height)) v->failed = 1;
        /* All benchmark surfaces keep one fixed geometry. */
        return;
    }
    if (!strcmp(a[0], "rect") && n == 6) {
        verify_layer* layer = verify_get_layer(v, integer(a[1]));
        if (!layer) return;
        layer->x = integer(a[2]); layer->y = integer(a[3]);
        layer->width = integer(a[4]); layer->height = integer(a[5]);
        if (!verify_bounds(v, layer->x, layer->y, layer->width, layer->height)) v->failed = 1;
        return;
    }
    if (!strcmp(a[0], "cfill") && n == 7) {
        verify_layer* layer = verify_get_layer(v, integer(a[2]));
        if (!layer) return;
        cairo_t* cr = cairo_create(layer->surface);
        cairo_set_operator(cr, verify_operator(integer(a[1])));
        cairo_rectangle(cr, layer->x, layer->y, layer->width, layer->height);
        cairo_set_source_rgba(cr, integer(a[3]) / 255.0, integer(a[4]) / 255.0,
                integer(a[5]) / 255.0, integer(a[6]) / 255.0);
        cairo_fill(cr); cairo_destroy(cr); v->fills++;
        return;
    }
    if (!strcmp(a[0], "copy") && n == 10) {
        verify_layer* source = verify_get_layer(v, integer(a[1]));
        verify_layer* target = verify_get_layer(v, integer(a[7]));
        int x = integer(a[2]), y = integer(a[3]), width = integer(a[4]), height = integer(a[5]);
        int dx = integer(a[8]), dy = integer(a[9]);
        if (!source || !target || !verify_bounds(v, x, y, width, height)
                || !verify_bounds(v, dx, dy, width, height)) { v->failed = 1; return; }
        /* Snapshot the source so overlapping self-copies match canvas semantics. */
        cairo_surface_t* part = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
        cairo_t* cr = cairo_create(part);
        cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
        cairo_set_source_surface(cr, source->surface, -x, -y); cairo_paint(cr); cairo_destroy(cr);
        cr = cairo_create(target->surface);
        cairo_rectangle(cr, dx, dy, width, height); cairo_clip(cr);
        cairo_set_operator(cr, verify_operator(integer(a[6])));
        cairo_set_source_surface(cr, part, dx, dy); cairo_paint(cr); cairo_destroy(cr);
        cairo_surface_destroy(part); v->copies++;
        return;
    }
    if (!strcmp(a[0], "img") && n == 7) {
        int id = integer(a[1]);
        if (id < 0 || id >= VERIFY_STREAMS || v->streams[id].active
                || (strcmp(a[4], "image/png") && strcmp(a[4], "image/webp"))) {
            v->failed = 1; return;
        }
        verify_stream* stream = &v->streams[id];
        stream->active = 1; stream->mode = integer(a[2]); stream->layer = integer(a[3]);
        stream->x = integer(a[5]); stream->y = integer(a[6]);
        stream->webp = !strcmp(a[4], "image/webp");
        return;
    }
    if (!strcmp(a[0], "blob") && n == 3) {
        int id = integer(a[1]);
        if (id < 0 || id >= VERIFY_STREAMS || !v->streams[id].active) { v->failed = 1; return; }
        verify_stream* stream = &v->streams[id];
        int count = guac_protocol_decode_base64(a[2]);
        if (count < 0 || (size_t) count > VERIFY_IMAGE_LIMIT - stream->length) { v->failed = 1; return; }
        size_t length = stream->length + (size_t) count;
        if (length > stream->capacity) {
            size_t capacity = stream->capacity ? stream->capacity : 8192;
            while (capacity < length) capacity *= 2;
            unsigned char* data = realloc(stream->data, capacity);
            if (!data) { v->failed = 1; return; }
            stream->data = data; stream->capacity = capacity;
        }
        memcpy(stream->data + stream->length, a[2], (size_t) count); stream->length = length;
        return;
    }
    if (!strcmp(a[0], "end") && n == 2) {
        int id = integer(a[1]);
        if (id < 0 || id >= VERIFY_STREAMS || !v->streams[id].active) { v->failed = 1; return; }
        verify_stream* stream = &v->streams[id];
        cairo_surface_t* image;
        if (stream->webp) {
            int width, height;
            unsigned char* rgba = WebPDecodeRGBA(stream->data, stream->length, &width, &height);
            if (!rgba || !verify_bounds(v, stream->x, stream->y, width, height)) {
                WebPFree(rgba); v->failed = 1; return;
            }
            image = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, height);
            unsigned char* rows = cairo_image_surface_get_data(image);
            int stride = cairo_image_surface_get_stride(image);
            for (int y = 0; y < height; y++) {
                uint32_t* row = (uint32_t*) (rows + y * stride);
                for (int x = 0; x < width; x++) {
                    const unsigned char* p = rgba + ((size_t) y * width + x) * 4;
                    if (p[3] != 255) v->failed = 1; /* Opaque fixtures only. */
                    row[x] = 0xFF000000U | p[0] << 16 | p[1] << 8 | p[2];
                }
            }
            cairo_surface_mark_dirty(image); WebPFree(rgba);
        }
        else image = cairo_image_surface_create_from_png_stream(verify_read_png, stream);
        verify_layer* target = verify_get_layer(v, stream->layer);
        int width = cairo_image_surface_get_width(image), height = cairo_image_surface_get_height(image);
        if (!target || cairo_surface_status(image)
                || !verify_bounds(v, stream->x, stream->y, width, height)) v->failed = 1;
        else {
            cairo_t* cr = cairo_create(target->surface);
            cairo_rectangle(cr, stream->x, stream->y, width, height); cairo_clip(cr);
            cairo_set_operator(cr, verify_operator(stream->mode));
            cairo_set_source_surface(cr, image, stream->x, stream->y); cairo_paint(cr); cairo_destroy(cr);
        }
        cairo_surface_destroy(image); free(stream->data); memset(stream, 0, sizeof(*stream)); v->images++;
        return;
    }
    fprintf(stderr, "Unsupported fixture instruction: %s (%d elements).\n", a[0], n);
    v->failed = 1;
}

static void verify_receive(verifier* v, const unsigned char* data, size_t length) {
    for (size_t i = 0; i < length && !v->failed; i++) {
        unsigned char c = data[i];
        if (v->state == 0) {
            if (c >= '0' && c <= '9' && v->digits < 5) {
                v->declared = v->declared * 10 + c - '0'; v->digits++;
            }
            else if (c == '.' && v->digits && v->argc < 128
                    && v->declared < sizeof(v->values) - v->used) {
                v->argv[v->argc++] = &v->values[v->used];
                v->remaining = v->declared; v->state = v->remaining ? 1 : 2;
            }
            else v->failed = 1;
        }
        else if (v->state == 1) {
            if (!c || c >= 128) { v->failed = 1; break; } /* NUL-free ASCII fixture protocol. */
            v->values[v->used++] = (char) c;
            if (!--v->remaining) v->state = 2;
        }
        else {
            v->values[v->used++] = '\0';
            if (c == ';') { verify_instruction(v); v->used = 0; v->argc = 0; }
            else if (c != ',') v->failed = 1;
            v->declared = 0; v->digits = 0; v->state = 0;
        }
    }
}

static void verify_destroy(verifier* v) {
    for (int i = 0; i < VERIFY_LAYERS; i++)
        if (v->layers[i].used) cairo_surface_destroy(v->layers[i].surface);
    for (int i = 0; i < VERIFY_STREAMS; i++) free(v->streams[i].data);
}

typedef struct sink {
    pthread_mutex_t socket_lock;
    pthread_mutex_t completion_lock;
    pthread_cond_t completed;
    uint64_t bytes;
    unsigned int frames;
    verifier* verify;
    size_t plan_images;
    uint64_t plan_pixels;
} sink;

typedef struct scenario {
    const char* name;
    int width, height;
    int dirty_width, dirty_height;
    int photo;
    int scroll;
    int pattern; /* 0=legacy,1=solid,2=no-hit,3=early-hit,4=late-hit,5=reuse */
} scenario;

static const scenario scenarios[] = {
    { "small-text", 3840, 2160, 160, 90, 0, 0, 0 },
    { "scroll-text", 3840, 2160, 1920, 1440, 0, 1, 0 },
    { "partial-text-redraw", 3840, 2160, 1920, 1440, 0, 0, 0 },
    { "mixed-4k-desktop", 3840, 2160, 3840, 2160, 2, 0, 0 },
    { "wallpaper-4k", 3840, 2160, 3840, 2160, 1, 0, 0 },
    { "partial-photo-on-4k", 3840, 2160, 2560, 1304, 1, 0, 0 },
    { "small-photo-on-4k", 3840, 2160, 1920, 944, 1, 0, 0 },
    { "window-1920x944", 1920, 944, 1920, 944, 1, 0, 0 },
    { "window-2560x1304", 2560, 1304, 2560, 1304, 1, 0, 0 },
    { "solid-color-4k", 3840, 2160, 3840, 2160, 0, 0, 1 },
    { "no-copy-hit", 3840, 2160, 1920, 1440, 0, 0, 2 },
    { "early-copy-hit", 1024, 1024, 1024, 1024, 0, 0, 3 },
    { "late-copy-hit", 1024, 1024, 1024, 1024, 0, 0, 4 },
    { "planner-reuse-alternating", 3840, 2160, 1920, 1440, 0, 0, 5 }
};

static double now(clockid_t clock) {
    struct timespec value;
    if (clock_gettime(clock, &value)) { perror("clock_gettime"); exit(1); }
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static void lock_socket(guac_socket* socket) {
    sink* output = socket->data;
    pthread_mutex_lock(&output->socket_lock);
}
static void unlock_socket(guac_socket* socket) {
    sink* output = socket->data;
    pthread_mutex_unlock(&output->socket_lock);
}
static ssize_t write_socket(guac_socket* socket, const void* data, size_t size) {
    sink* output = socket->data;
    if (output->verify) verify_receive(output->verify, data, size);
    output->bytes += size;
    return (ssize_t) size;
}
static ssize_t complete_frame(guac_socket* socket) {
    sink* output = socket->data;
    pthread_mutex_lock(&output->completion_lock);
    output->frames++;
    pthread_cond_signal(&output->completed);
    pthread_mutex_unlock(&output->completion_lock);
    return 0;
}

/* Read numeric production TRACE arguments without formatting or retaining any
 * image data. Other existing log calls do not affect benchmark metadata. */
static void planning_statistics(guac_client* client, guac_client_log_level level,
        const char* format, va_list arguments) {
    (void) level;
    if (strcmp(format, "Encoder batch: active-limit=%i pool=%i images=%zu pixels=%" PRIu64 "."))
        return;
    sink* output = client->data;
    va_list copy;
    va_copy(copy, arguments);
    (void) va_arg(copy, int);
    (void) va_arg(copy, int);
    output->plan_images = va_arg(copy, size_t);
    output->plan_pixels = va_arg(copy, uint64_t);
    va_end(copy);
}

static int wait_frame(sink* output, guac_display* display, unsigned int expected) {
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 45;
    pthread_mutex_lock(&output->completion_lock);
    while (output->frames < expected) {
        int error = pthread_cond_timedwait(&output->completed,
                &output->completion_lock, &deadline);
        if (error) {
            fprintf(stderr, "Frame completion timed out: %s\n", strerror(error));
            pthread_mutex_unlock(&output->completion_lock);
            return 0;
        }
    }
    int exact = output->frames == expected;
    pthread_mutex_unlock(&output->completion_lock);
    /* The final socket flush executes under the FIFO lock. Acquiring it here
     * also waits for active-worker accounting and teardown of that last task. */
    guac_fifo_lock(&display->ops);
    exact &= display->ops.item_count == 0 && display->active_workers == 0;
    guac_fifo_unlock(&display->ops);
    return exact;
}

static uint32_t seeded_pixel(unsigned int x, unsigned int y, unsigned int frame) {
    uint32_t value = 0x97531U ^ x * 2654435761U ^ y * 2246822519U ^ frame * 3266489917U;
    value ^= value << 13; value ^= value >> 17; value ^= value << 5;
    return value & 0xFFFFFFU;
}

/* The far-corner pixel keeps refined dirty/search bounds full-sized while
 * leaving only the copied 64x64 tile as an indexable candidate. */
static void seed_background(uint32_t* pixels, const scenario* item) {
    for (int y = 0; y < item->height; y++)
        for (int x = 0; x < item->width; x++)
            pixels[(size_t) y * item->width + x] = item->pattern == 3 || item->pattern == 4
                ? seeded_pixel((unsigned int) x, (unsigned int) y, 0) : 0;
}

static void fixture(uint32_t* pixels, const scenario* item, unsigned int frame) {
    uint32_t random = 0x97531U + frame * 17U;
    for (int y = 0; y < item->dirty_height; y++) {
        int document_y = y + (item->scroll ? (int) frame * 7 : 0);
        for (int x = 0; x < item->dirty_width; x++) {
            uint32_t pixel;
            if (item->pattern == 1)
                pixel = ((frame * 37U) & 255U) * 0x010101U;
            else if (item->pattern == 2)
                pixel = seeded_pixel((unsigned int) x, (unsigned int) y, frame);
            else if (item->pattern == 3 || item->pattern == 4) {
                int source_x = item->pattern == 3 ? 128 + (int) (frame % 4) * 64
                    : item->width - 64 * (2 + (int) (frame % 4));
                int source_y = item->pattern == 3 ? 0 : item->height - 64;
                pixel = seeded_pixel((unsigned int) (x < 64 && y < 64 ? source_x + x : x),
                        (unsigned int) (x < 64 && y < 64 ? source_y + y : y), 0);
                if (x == item->width - 1 && y == item->height - 1) pixel ^= frame + 1;
            }
            else if (item->pattern == 5 && (x >= (frame % 3 == 0 ? 160 : frame % 3 == 1 ? 1024 : 1920)
                        || y >= (frame % 3 == 0 ? 90 : frame % 3 == 1 ? 768 : 1440)))
                pixel = 0;
            else if (item->photo && (item->photo == 1 || x >= item->dirty_width / 2)) {
                random ^= random << 13; random ^= random >> 17; random ^= random << 5;
                unsigned int grain = random & 15;
                unsigned int red = (x * 225 / item->dirty_width + grain + frame) & 255;
                unsigned int green = (y * 225 / item->dirty_height + grain) & 255;
                unsigned int blue = ((x + y) * 127 / (item->dirty_width + item->dirty_height) + grain) & 255;
                pixel = red << 16 | green << 8 | blue;
            }
            else {
                unsigned int line = (unsigned int) document_y / 24;
                unsigned int glyph = ((unsigned int) x / 9 + line * 13U
                        + (item->scroll ? 0 : frame * 7U)) * 2654435761U;
                int ink = document_y % 24 >= 5 && document_y % 24 < 17
                    && x % 9 < 6 && ((glyph >> ((document_y % 6) + (x % 3))) & 1);
                unsigned int shade = ink ? 48 : 244;
                pixel = shade * 0x010101U;
            }
            pixels[(size_t) y * item->dirty_width + x] = pixel;
        }
    }
}

typedef struct verification_result {
    uint64_t frames, pixels, instructions, images, copies, fills, pixel_hash;
} verification_result;

/* An untimed independent replay catches invalid copy/fill/image output, not
 * merely a correct server-side snapshot. All image formats are forced lossless
 * here; measured frames retain their original format/quality decisions.
 * Failures terminate the isolated case child immediately: unwinding a stack
 * sink while display workers still reference it would be unsafe, and waiting
 * for orderly teardown after a frame timeout could stall the benchmark. */
static int verify_case(const scenario* item, const char* mode, int active_cap,
        int count, verification_result* result) {
    if (!count) return 1;
    verifier v = { .width = item->width, .height = item->height };
    sink output = { .verify = &v };
    pthread_mutex_init(&output.socket_lock, NULL);
    pthread_mutex_init(&output.completion_lock, NULL);
    pthread_cond_init(&output.completed, NULL);
    guac_client* client = guac_client_alloc();
    guac_socket* socket = guac_socket_alloc();
    uint32_t* expected = malloc((size_t) item->width * item->height * 4);
    uint32_t* pixels = malloc((size_t) item->dirty_width * item->dirty_height * 4);
    if (!client || !socket || !expected || !pixels) {
        fprintf(stderr, "Unable to allocate replay for %s.\n", item->name); exit(1);
    }
    guac_socket_free(client->socket);
    client->data = &output; client->socket = socket;
    socket->data = &output; socket->write_handler = write_socket;
    socket->lock_handler = lock_socket; socket->unlock_handler = unlock_socket;
    socket->flush_handler = complete_frame;
    guac_display* display = guac_display_alloc(client);
    if (!display || !display->worker_thread_count) {
        fprintf(stderr, "Unable to start replay display for %s.\n", item->name); exit(1);
    }
    if (strcmp(mode, "baseline")) {
        union { void* pointer; void (*function)(guac_display*, int); } policy;
        policy.pointer = dlsym(RTLD_DEFAULT, "guac_display_set_worker_policy");
        if (!policy.pointer) { fprintf(stderr, "Replay policy symbol unavailable.\n"); exit(1); }
        policy.function(display, !strcmp(mode, "adaptive") ? active_cap : 0);
    }
    guac_display_layer* layer = guac_display_default_layer(display);
    guac_display_layer_set_lossless(layer, 1);
    guac_display_layer_resize(layer, item->width, item->height);
    seed_background(expected, item);
    guac_rect full = { 0, 0, item->width, item->height };
    guac_display_layer_raw_context* context = guac_display_layer_open_raw(layer);
    guac_display_layer_raw_context_put(context, &full, expected, (size_t) item->width * 4);
    guac_display_layer_close_raw(layer, context);
    guac_display_end_multiple_frames(display, 1);
    if (!wait_frame(&output, display, 1)) exit(1);

    guac_rect dirty = { 0, 0, item->dirty_width, item->dirty_height };
    for (int i = 1; i <= count; i++) {
        fixture(pixels, item, (unsigned int) i);
        for (int y = 0; y < item->dirty_height; y++)
            memcpy(expected + (size_t) y * item->width,
                    pixels + (size_t) y * item->dirty_width, (size_t) item->dirty_width * 4);
        context = guac_display_layer_open_raw(layer);
        guac_display_layer_raw_context_put(context, &dirty, pixels, (size_t) item->dirty_width * 4);
        guac_display_layer_close_raw(layer, context);
        guac_display_end_multiple_frames(display, 1);
        if (!wait_frame(&output, display, (unsigned int) i + 1)) exit(1);
        verify_layer* rendered = verify_get_layer(&v, 0);
        if (!rendered || v.failed || v.state || v.digits || v.argc || v.used
                || v.syncs != (uint64_t) i + 1) {
            fprintf(stderr, "Protocol verification failed for %s, frame %i.\n", item->name, i);
            exit(1);
        }
        for (int stream = 0; stream < VERIFY_STREAMS; stream++)
            if (v.streams[stream].active) {
                fprintf(stderr, "Unclosed image stream for %s, frame %i.\n", item->name, i);
                exit(1);
            }
        cairo_surface_flush(rendered->surface);
        const unsigned char* rows = cairo_image_surface_get_data(rendered->surface);
        int stride = cairo_image_surface_get_stride(rendered->surface);
        uint64_t hash = UINT64_C(14695981039346656037);
        for (int y = 0; y < item->height; y++) {
            const uint32_t* row = (const uint32_t*) (rows + y * stride);
            for (int x = 0; x < item->width; x++) {
                uint32_t actual = row[x] & 0xFFFFFFU;
                if (actual != (expected[(size_t) y * item->width + x] & 0xFFFFFFU)) {
                    fprintf(stderr, "Pixel mismatch for %s frame %i at %i,%i.\n", item->name, i, x, y);
                    exit(1);
                }
                hash = (hash ^ actual) * UINT64_C(1099511628211);
            }
        }
        result->frames++; result->pixels += (uint64_t) item->width * item->height;
        result->pixel_hash = hash;
    }
    result->instructions = v.instructions; result->images = v.images;
    result->copies = v.copies; result->fills = v.fills;
    output.verify = NULL;
    guac_display_free(display); guac_client_free(client);
    free(expected); free(pixels); verify_destroy(&v);
    pthread_cond_destroy(&output.completed);
    pthread_mutex_destroy(&output.completion_lock); pthread_mutex_destroy(&output.socket_lock);
    return 1;
}

static int compare_double(const void* left, const void* right) {
    double a = *(const double*) left, b = *(const double*) right;
    return (a > b) - (a < b);
}
static double percentile(const double* values, int count, int percent) {
    return values[(count * percent + 99) / 100 - 1];
}

static int run_case(int index, const char* mode, int samples, int warmup, int active_cap, int verify_frames) {
    const scenario* item = &scenarios[index];
    sink output = { 0 };
    pthread_mutex_init(&output.socket_lock, NULL);
    pthread_mutex_init(&output.completion_lock, NULL);
    pthread_cond_init(&output.completed, NULL);
    guac_client* client = guac_client_alloc();
    guac_socket* socket = guac_socket_alloc();
    uint32_t* pixels = malloc((size_t) item->dirty_width * item->dirty_height * sizeof(uint32_t));
    double* elapsed = malloc((size_t) samples * sizeof(double));
    if (!client || !socket || !pixels || !elapsed) {
        fprintf(stderr, "Unable to allocate production benchmark.\n"); return 1;
    }
    guac_socket_free(client->socket);
    client->data = &output;
    client->log_handler = planning_statistics;
    client->socket = socket;
    socket->data = &output;
    socket->write_handler = write_socket;
    socket->lock_handler = lock_socket;
    socket->unlock_handler = unlock_socket;
    socket->flush_handler = complete_frame;
    guac_display* display = guac_display_alloc(client);
    if (!display || display->worker_thread_count == 0) return 1;

    union { void* pointer; void (*function)(guac_display*, int); } policy;
    policy.pointer = dlsym(RTLD_DEFAULT, "guac_display_set_worker_policy");
    /* Baseline means that library's shipped policy, including private.6's
     * default twelve-worker admission. Symbol presence is not a version test.
     * Setter value 1 enables the library default, not a one-worker limit. */
    if (strcmp(mode, "baseline")) {
        if (!policy.pointer) { fprintf(stderr, "candidate policy symbol unavailable\n"); return 1; }
        policy.function(display, !strcmp(mode, "adaptive") ? active_cap : 0);
    }
    union { void* pointer; int (*function)(guac_display*, uint64_t*, size_t); } statistics;
    statistics.pointer = dlsym(RTLD_DEFAULT, "guac_display_get_planner_statistics");
    uint64_t stats_start[10] = { 0 }, stats_end[10] = { 0 }, scratch_peak = 0;
    int stats_available = 0;
    int actual_workers = display->worker_thread_count;
    guac_display_layer* layer = guac_display_default_layer(display);
    guac_display_layer_resize(layer, item->width, item->height);
    if (item->pattern == 3 || item->pattern == 4) {
        uint32_t* background = malloc((size_t) item->width * item->height * sizeof(uint32_t));
        if (!background) return 1;
        seed_background(background, item);
        guac_rect full = { 0, 0, item->width, item->height };
        guac_display_layer_raw_context* initial = guac_display_layer_open_raw(layer);
        guac_display_layer_raw_context_put(initial, &full, background, (size_t) item->width * 4);
        guac_display_layer_close_raw(layer, initial); free(background);
    }
    /* Initial allocation/full snapshot is excluded from measured steady-state
     * frames. It exercises the exact same completion path as measured frames. */
    guac_display_end_multiple_frames(display, 1);
    if (!wait_frame(&output, display, 1)) return 1;

    double cpu = 0;
    uint64_t bytes = 0;
    unsigned int expected = 1;
    int active_min = 65, active_max = 0;
    uint64_t pixels_min = UINT64_MAX, pixels_max = 0;
    size_t images_min = SIZE_MAX, images_max = 0;
    guac_rect dirty = { 0, 0, item->dirty_width, item->dirty_height };
    for (int i = -warmup; i < samples; i++) {
        fixture(pixels, item, (unsigned int) (i + warmup + 1));
        if (i == 0) {
            bytes = output.bytes;
            if (statistics.pointer) stats_available = statistics.function(display, stats_start, 10);
        }
        double cpu_started = now(CLOCK_PROCESS_CPUTIME_ID);
        double started = now(CLOCK_MONOTONIC);
        guac_display_layer_raw_context* context = guac_display_layer_open_raw(layer);
        guac_display_layer_raw_context_put(context, &dirty, pixels,
                (size_t) item->dirty_width * sizeof(uint32_t));
        guac_display_layer_close_raw(layer, context);
        guac_display_end_multiple_frames(display, 1);
        if (!wait_frame(&output, display, ++expected)) return 1;
        if (i >= 0) {
            elapsed[i] = now(CLOCK_MONOTONIC) - started;
            cpu += now(CLOCK_PROCESS_CPUTIME_ID) - cpu_started;
            if (stats_available) {
                if (!statistics.function(display, stats_end, 10)) return 1;
                if (stats_end[9] > scratch_peak) scratch_peak = stats_end[9];
            }
            if (output.plan_pixels < pixels_min) pixels_min = output.plan_pixels;
            if (output.plan_pixels > pixels_max) pixels_max = output.plan_pixels;
            if (output.plan_images < images_min) images_min = output.plan_images;
            if (output.plan_images > images_max) images_max = output.plan_images;
#ifdef BENCH_CONCURRENCY_FIELDS
            guac_fifo_lock(&display->ops);
            int limit = display->worker_active_limit;
            guac_fifo_unlock(&display->ops);
            if (limit < active_min) active_min = limit;
            if (limit > active_max) active_max = limit;
#endif
        }
    }
    double cpu_per_frame = cpu / samples;
    double bytes_per_frame = (double) (output.bytes - bytes) / samples;
    qsort(elapsed, (size_t) samples, sizeof(double), compare_double);
    /* Keep timing summaries independent of the untimed replay and release
     * their backing samples before allocating its image buffers. */
    double frame_p50 = percentile(elapsed, samples, 50);
    double frame_p95 = percentile(elapsed, samples, 95);
    struct rusage usage;
    getrusage(RUSAGE_SELF, &usage);
    long rss = usage.ru_maxrss;
#ifdef __APPLE__
    rss /= 1024;
#endif
    int committed_width = layer->last_frame.width, committed_height = layer->last_frame.height;
    guac_display_free(display);
    guac_client_free(client);
    free(pixels); free(elapsed);
    verification_result verification = { 0 };
    if (!verify_case(item, mode, active_cap, verify_frames, &verification)) return 1;
    printf("{\"scenario\":\"%s\",\"mode\":\"%s\",\"pool_workers\":%d,"
            "\"samples\":%d,\"warmup_frames\":%d,\"width\":%d,\"height\":%d,"
            "\"dirty_width\":%d,\"dirty_height\":%d,\"frame_p50_ms\":%.3f,"
            "\"frame_p95_ms\":%.3f,\"cpu_ms_per_frame\":%.3f,"
            "\"protocol_bytes_per_frame\":%.1f,\"peak_rss_kib\":%ld,"
            "\"test_active_cap\":%d,\"observed_active_limit_min\":%d,"
            "\"observed_active_limit_max\":%d,\"plan_image_pixels_min\":%" PRIu64 ","
            "\"plan_image_pixels_max\":%" PRIu64 ",\"plan_images_min\":%zu,"
            "\"plan_images_max\":%zu,\"committed_desktop_width\":%d,"
            "\"committed_desktop_height\":%d,",
            item->name, mode, actual_workers, samples, warmup, item->width, item->height,
            item->dirty_width, item->dirty_height, frame_p50,
            frame_p95, cpu_per_frame, bytes_per_frame, rss,
            active_cap, active_min == 65 ? 0 : active_min, active_max,
            pixels_min, pixels_max, images_min, images_max,
            committed_width, committed_height);
    printf("\"policy_control\":\"%s\",\"policy_symbol_available\":%s,",
            !strcmp(mode, "baseline") ? "baseline-library-default" : !strcmp(mode, "fixed")
                ? "candidate-fixed-full-pool" : "candidate-adaptive",
            policy.pointer ? "true" : "false");
    printf("\"policy_setter_value\":");
    if (!strcmp(mode, "baseline")) printf("null");
    else printf("%d", !strcmp(mode, "adaptive") ? active_cap : 0);
    printf(",");
    printf("\"planner_statistics\":");
    if (stats_available) {
        static const char* names[9] = { "plan_allocations", "plan_reuses", "op_array_allocations",
            "hash_buckets_cleared", "copy_candidates_indexed", "copy_windows_scanned",
            "exact_copy_matches", "empty_searches_skipped", "exhausted_searches_stopped" };
        printf("{");
        for (int i = 0; i < 9; i++) {
            if (stats_end[i] < stats_start[i]) return 1;
            printf("%s\"%s\":%" PRIu64, i ? "," : "", names[i], stats_end[i] - stats_start[i]);
        }
        printf(",\"scratch_bytes_final\":%" PRIu64 ",\"scratch_bytes_peak\":%" PRIu64 "}",
                stats_end[9], scratch_peak);
    }
    else printf("null");
    printf(",\"verification\":{\"enabled\":%s,\"frames\":%" PRIu64 ",\"rgb_pixels_compared\":%" PRIu64
            ",\"instructions\":%" PRIu64 ",\"images\":%" PRIu64 ",\"copies\":%" PRIu64
            ",\"fills\":%" PRIu64 ",\"final_rgb_hash\":\"%016" PRIx64 "\"}}\n",
            verify_frames ? "true" : "false", verification.frames, verification.pixels,
            verification.instructions, verification.images, verification.copies, verification.fills,
            verification.pixel_hash);
    pthread_cond_destroy(&output.completed);
    pthread_mutex_destroy(&output.completion_lock);
    pthread_mutex_destroy(&output.socket_lock);
    return 0;
}

int main(int argc, char** argv) {
    if (argc < 4 || argc > 7 || (strcmp(argv[1], "baseline") && strcmp(argv[1], "fixed")
                && strcmp(argv[1], "adaptive"))) return 1;
    int samples = atoi(argv[2]), warmup = atoi(argv[3]);
    int active_cap = argc >= 5 ? atoi(argv[4]) : 1;
    if (samples < 2 || samples > 1000 || warmup < 0 || warmup > 100) return 1;
    if (active_cap < 1 || active_cap > 64) return 1;
    int verify_frames = argc == 7 ? atoi(argv[6]) : 4;
    if (verify_frames < 0 || verify_frames > 10) return 1;
    /* Each case starts in a fresh child so RSS and codec caches are local to
     * the workload. Pool startup and fixture generation precede timed frames. */
    for (unsigned int i = 0; i < sizeof(scenarios) / sizeof(*scenarios); i++) {
        if (argc >= 6) {
            const char* found = strstr(argv[5], scenarios[i].name);
            size_t length = strlen(scenarios[i].name);
            if (!found || (found != argv[5] && found[-1] != ',')
                    || (found[length] && found[length] != ','))
                continue;
        }
        fflush(stdout);
        pid_t child = fork();
        if (child < 0) return 1;
        if (!child) exit(run_case((int) i, argv[1], samples, warmup, active_cap, verify_frames));
        int status;
        if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status)) return 1;
    }
    return 0;
}
