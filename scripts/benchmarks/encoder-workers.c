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

/* Isolated encoding microbenchmark. Uses production libguac codecs and blob
 * serialization, with persistent worker threads and a shared, mutex-protected
 * discard socket. There is no RDP connection, browser, or network traffic. */
#include "encode-jpeg.h"
#include "encode-png.h"
#include "encode-webp.h"
#include "guacamole/socket.h"
#include "guacamole/stream.h"

#include <errno.h>
#include <inttypes.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

typedef struct benchmark {
    pthread_mutex_t work_lock;
    pthread_cond_t work_ready;
    pthread_cond_t work_done;
    pthread_mutex_t socket_lock;
    guac_socket* socket;
    uint32_t* ui;
    uint32_t* photo;
    uint64_t bytes;
    int width;
    int height;
    int tasks;
    int workers;
    int scenario;
    int generation;
    int next;
    int completed;
    int failed;
    int stop;
} benchmark;

typedef struct worker {
    benchmark* state;
    int index;
} worker;

static const char* scenarios[] = {
    "small-text", "scroll-text", "mixed-4k-desktop", "wallpaper-4k-webp"
};

static double now(clockid_t clock) {
    struct timespec value;
    if (clock_gettime(clock, &value) != 0) {
        perror("clock_gettime");
        exit(1);
    }
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
}

static void lock_socket(guac_socket* socket) {
    benchmark* state = socket->data;
    pthread_mutex_lock(&state->socket_lock);
}

static void unlock_socket(guac_socket* socket) {
    benchmark* state = socket->data;
    pthread_mutex_unlock(&state->socket_lock);
}

static ssize_t discard_write(guac_socket* socket, const void* data, size_t count) {
    benchmark* state = socket->data;
    (void) data;
    state->bytes += count;
    return (ssize_t) count;
}

static void* encode_worker(void* argument) {
    worker* self = argument;
    benchmark* state = self->state;
    guac_stream stream = { .index = self->index };
    int generation = 0;

    pthread_mutex_lock(&state->work_lock);
    while (!state->stop) {
        while (generation == state->generation && !state->stop)
            pthread_cond_wait(&state->work_ready, &state->work_lock);
        if (state->stop)
            break;
        generation = state->generation;

        while (state->next < state->tasks) {
            int task = state->next++;
            pthread_mutex_unlock(&state->work_lock);
            int codec = state->scenario < 2 ? 0
                : state->scenario == 3 ? 2 : task % 3;
            uint32_t* pixels = codec == 0 ? state->ui : state->photo;
            cairo_surface_t* surface = cairo_image_surface_create_for_data(
                    (unsigned char*) pixels, CAIRO_FORMAT_RGB24,
                    state->width, state->height, state->width * 4);
            int result = cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS;
            if (!result) {
                if (codec == 0)
                    result = guac_png_write(state->socket, &stream, surface);
                else if (codec == 1)
                    result = guac_jpeg_write(state->socket, &stream, surface, 80);
                else
                    result = guac_webp_write(state->socket, &stream, surface, 80, 0);
            }
            cairo_surface_destroy(surface);
            pthread_mutex_lock(&state->work_lock);
            state->failed |= result != 0;
        }

        if (++state->completed == state->workers)
            pthread_cond_signal(&state->work_done);
    }
    pthread_mutex_unlock(&state->work_lock);
    return NULL;
}

static int compare_double(const void* left, const void* right) {
    double a = *(const double*) left;
    double b = *(const double*) right;
    return (a > b) - (a < b);
}

/* Nearest-rank percentiles: no interpolation hides a slow observed frame. */
static double percentile(const double* values, int count, int percent) {
    return values[(count * percent + 99) / 100 - 1];
}

static int run_case(int workers, int scenario, int samples, int warmup) {
    benchmark state = { 0 };
    state.workers = workers;
    state.scenario = scenario;
    state.width = scenario == 0 ? 160 : scenario == 1 ? 320 : 640;
    state.height = scenario == 0 ? 90 : scenario == 1 ? 180 : 540;
    state.tasks = scenario == 0 ? 4 : scenario == 1 ? 48 : 24;
    size_t pixel_count = (size_t) state.width * state.height;
    state.ui = malloc(pixel_count * sizeof(uint32_t));
    state.photo = malloc(pixel_count * sizeof(uint32_t));
    double* elapsed = malloc((size_t) samples * sizeof(double));
    state.socket = guac_socket_alloc();
    if (!state.ui || !state.photo || !elapsed || !state.socket) {
        fprintf(stderr, "Unable to allocate benchmark fixtures.\n");
        return 1;
    }

    /* Deterministic synthetic fixtures, with no user screen contents: sparse
     * grayscale UI-like rows, and a gradient with a little image-like grain. */
    uint32_t random = 0x97531;
    for (int y = 0; y < state.height; y++) {
        for (int x = 0; x < state.width; x++) {
            size_t offset = (size_t) y * state.width + x;
            int shade = y % 24 < 12 && x % 93 > 8 && x % 7 > 1 ? 48 : 244;
            state.ui[offset] = (uint32_t) shade * 0x010101;
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            unsigned int grain = random & 15;
            unsigned int red = (x * 225 / state.width + grain) & 255;
            unsigned int green = (y * 225 / state.height + grain) & 255;
            unsigned int blue = ((x + y) * 127 / (state.width + state.height) + grain) & 255;
            state.photo[offset] = red << 16 | green << 8 | blue;
        }
    }

    pthread_mutex_init(&state.work_lock, NULL);
    pthread_mutex_init(&state.socket_lock, NULL);
    pthread_cond_init(&state.work_ready, NULL);
    pthread_cond_init(&state.work_done, NULL);
    state.socket->data = &state;
    state.socket->write_handler = discard_write;
    state.socket->lock_handler = lock_socket;
    state.socket->unlock_handler = unlock_socket;

    pthread_t threads[64];
    worker arguments[64];
    for (int i = 0; i < workers; i++) {
        arguments[i] = (worker) { .state = &state, .index = i };
        int result = pthread_create(&threads[i], NULL, encode_worker, &arguments[i]);
        if (result != 0) {
            fprintf(stderr, "pthread_create: %s\n", strerror(result));
            exit(1);
        }
    }

    double cpu_start = 0;
    uint64_t bytes_start = 0;
    for (int i = -warmup; i < samples; i++) {
        if (i == 0) {
            cpu_start = now(CLOCK_PROCESS_CPUTIME_ID);
            bytes_start = state.bytes;
        }
        double start = now(CLOCK_MONOTONIC);
        pthread_mutex_lock(&state.work_lock);
        state.next = state.completed = 0;
        state.generation++;
        pthread_cond_broadcast(&state.work_ready);
        while (state.completed != workers)
            pthread_cond_wait(&state.work_done, &state.work_lock);
        pthread_mutex_unlock(&state.work_lock);
        if (i >= 0)
            elapsed[i] = now(CLOCK_MONOTONIC) - start;
    }
    double cpu_per_frame = (now(CLOCK_PROCESS_CPUTIME_ID) - cpu_start) / samples;
    double bytes_per_frame = (double) (state.bytes - bytes_start) / samples;

    pthread_mutex_lock(&state.work_lock);
    state.stop = 1;
    pthread_cond_broadcast(&state.work_ready);
    pthread_mutex_unlock(&state.work_lock);
    for (int i = 0; i < workers; i++)
        pthread_join(threads[i], NULL);
    if (state.failed) {
        fprintf(stderr, "A production encoder failed.\n");
        return 1;
    }

    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage) != 0) {
        perror("getrusage");
        return 1;
    }
    long rss_kib = usage.ru_maxrss;
#ifdef __APPLE__
    rss_kib /= 1024;
#endif
    qsort(elapsed, (size_t) samples, sizeof(double), compare_double);
    printf("{\"scenario\":\"%s\",\"workers\":%d,\"samples\":%d,"
            "\"warmup_frames\":%d,\"tasks_per_frame\":%d,\"tile_width\":%d,"
            "\"tile_height\":%d,\"frame_p50_ms\":%.3f,\"frame_p95_ms\":%.3f,"
            "\"cpu_ms_per_frame\":%.3f,\"protocol_bytes_per_frame\":%.1f,"
            "\"peak_rss_kib\":%ld}\n",
            scenarios[scenario], workers, samples, warmup, state.tasks,
            state.width, state.height, percentile(elapsed, samples, 50),
            percentile(elapsed, samples, 95), cpu_per_frame, bytes_per_frame, rss_kib);

    guac_socket_free(state.socket);
    free(state.ui);
    free(state.photo);
    free(elapsed);
    pthread_cond_destroy(&state.work_ready);
    pthread_cond_destroy(&state.work_done);
    pthread_mutex_destroy(&state.work_lock);
    pthread_mutex_destroy(&state.socket_lock);
    return 0;
}

static int parse_number(const char* text, int min, int max) {
    char* end;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || *text == '\0' || *end != '\0' || value < min || value > max) {
        fprintf(stderr, "Invalid bounded benchmark argument.\n");
        exit(1);
    }
    return (int) value;
}

int main(int argc, char** argv) {
    if (argc == 5)
        return run_case(parse_number(argv[1], 1, 64),
                parse_number(argv[2], 0, 3), parse_number(argv[3], 2, 1000),
                parse_number(argv[4], 0, 100));

    if (argc != 3) {
        fprintf(stderr, "Usage: %s samples warmup (all cases), or workers "
                "scenario samples warmup (one case).\n", argv[0]);
        return 1;
    }

    /* Use a fresh child per case so peak RSS does not include earlier pools.
     * Rotate count order between fixtures to reduce systematic warm-host bias. */
    const char* counts[] = { "2", "4", "8", "22" };
    for (int scenario = 0; scenario < 4; scenario++) {
        for (int index = 0; index < 4; index++) {
            char which[2] = { (char) ('0' + scenario), '\0' };
            pid_t child = fork();
            if (child == 0) {
                execl(argv[0], argv[0], counts[(index + scenario) % 4], which,
                        argv[1], argv[2], (char*) NULL);
                perror("execl");
                _exit(1);
            }
            int status;
            if (child < 0 || waitpid(child, &status, 0) != child
                    || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
                return 1;
        }
    }
    return 0;
}
