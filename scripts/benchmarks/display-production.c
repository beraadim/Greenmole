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
#include "guacamole/socket.h"

#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
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

typedef struct sink {
    pthread_mutex_t socket_lock;
    pthread_mutex_t completion_lock;
    pthread_cond_t completed;
    uint64_t bytes;
    unsigned int frames;
    size_t plan_images;
    uint64_t plan_pixels;
} sink;

typedef struct scenario {
    const char* name;
    int width, height;
    int dirty_width, dirty_height;
    int photo;
    int scroll;
} scenario;

static const scenario scenarios[] = {
    { "small-text", 3840, 2160, 160, 90, 0, 0 },
    { "scroll-text", 3840, 2160, 1920, 1440, 0, 1 },
    { "partial-text-redraw", 3840, 2160, 1920, 1440, 0, 0 },
    { "mixed-4k-desktop", 3840, 2160, 3840, 2160, 2, 0 },
    { "wallpaper-4k", 3840, 2160, 3840, 2160, 1, 0 },
    { "partial-photo-on-4k", 3840, 2160, 2560, 1304, 1, 0 },
    { "small-photo-on-4k", 3840, 2160, 1920, 944, 1, 0 },
    { "window-1920x944", 1920, 944, 1920, 944, 1, 0 },
    { "window-2560x1304", 2560, 1304, 2560, 1304, 1, 0 }
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
    (void) data;
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

static void fixture(uint32_t* pixels, const scenario* item, unsigned int frame) {
    uint32_t random = 0x97531U + frame * 17U;
    for (int y = 0; y < item->dirty_height; y++) {
        int document_y = y + (item->scroll ? (int) frame * 7 : 0);
        for (int x = 0; x < item->dirty_width; x++) {
            uint32_t pixel;
            if (item->photo && (item->photo == 1 || x >= item->dirty_width / 2)) {
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

static int compare_double(const void* left, const void* right) {
    double a = *(const double*) left, b = *(const double*) right;
    return (a > b) - (a < b);
}
static double percentile(const double* values, int count, int percent) {
    return values[(count * percent + 99) / 100 - 1];
}

static int run_case(int index, const char* mode, int samples, int warmup, int active_cap) {
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
    if (!strcmp(mode, "baseline")) {
        if (policy.pointer) { fprintf(stderr, "baseline requires the old library\n"); return 1; }
    }
    else {
        if (!policy.pointer) { fprintf(stderr, "candidate policy symbol unavailable\n"); return 1; }
        policy.function(display, !strcmp(mode, "adaptive") ? active_cap : 0);
    }
    int actual_workers = display->worker_thread_count;
    guac_display_layer* layer = guac_display_default_layer(display);
    guac_display_layer_resize(layer, item->width, item->height);
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
    struct rusage usage;
    getrusage(RUSAGE_SELF, &usage);
    long rss = usage.ru_maxrss;
#ifdef __APPLE__
    rss /= 1024;
#endif
    printf("{\"scenario\":\"%s\",\"mode\":\"%s\",\"pool_workers\":%d,"
            "\"samples\":%d,\"warmup_frames\":%d,\"width\":%d,\"height\":%d,"
            "\"dirty_width\":%d,\"dirty_height\":%d,\"frame_p50_ms\":%.3f,"
            "\"frame_p95_ms\":%.3f,\"cpu_ms_per_frame\":%.3f,"
            "\"protocol_bytes_per_frame\":%.1f,\"peak_rss_kib\":%ld,"
            "\"test_active_cap\":%d,\"observed_active_limit_min\":%d,"
            "\"observed_active_limit_max\":%d,\"plan_image_pixels_min\":%" PRIu64 ","
            "\"plan_image_pixels_max\":%" PRIu64 ",\"plan_images_min\":%zu,"
            "\"plan_images_max\":%zu,\"committed_desktop_width\":%d,"
            "\"committed_desktop_height\":%d}\n",
            item->name, mode, actual_workers, samples, warmup, item->width, item->height,
            item->dirty_width, item->dirty_height, percentile(elapsed, samples, 50),
            percentile(elapsed, samples, 95), cpu_per_frame, bytes_per_frame, rss,
            active_cap, active_min == 65 ? 0 : active_min, active_max,
            pixels_min, pixels_max, images_min, images_max,
            layer->last_frame.width, layer->last_frame.height);
    guac_display_free(display);
    guac_client_free(client);
    free(pixels); free(elapsed);
    pthread_cond_destroy(&output.completed);
    pthread_mutex_destroy(&output.completion_lock);
    pthread_mutex_destroy(&output.socket_lock);
    return 0;
}

int main(int argc, char** argv) {
    if (argc < 4 || argc > 6 || (strcmp(argv[1], "baseline") && strcmp(argv[1], "fixed")
                && strcmp(argv[1], "adaptive"))) return 1;
    int samples = atoi(argv[2]), warmup = atoi(argv[3]);
    int active_cap = argc >= 5 ? atoi(argv[4]) : 1;
    if (samples < 2 || samples > 1000 || warmup < 0 || warmup > 100) return 1;
    if (active_cap < 1 || active_cap > 64) return 1;
    /* Each case starts in a fresh child so RSS and codec caches are local to
     * the workload. Pool startup and fixture generation precede timed frames. */
    for (unsigned int i = 0; i < sizeof(scenarios) / sizeof(*scenarios); i++) {
        if (argc == 6) {
            const char* found = strstr(argv[5], scenarios[i].name);
            size_t length = strlen(scenarios[i].name);
            if (!found || (found != argv[5] && found[-1] != ',')
                    || (found[length] && found[length] != ','))
                continue;
        }
        fflush(stdout);
        pid_t child = fork();
        if (child < 0) return 1;
        if (!child) exit(run_case((int) i, argv[1], samples, warmup, active_cap));
        int status;
        if (waitpid(child, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status)) return 1;
    }
    return 0;
}
