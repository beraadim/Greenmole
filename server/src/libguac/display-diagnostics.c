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

#include "display-diagnostics.h"
#include "display-priv.h"
#include "guacamole/client.h"
#include "guacamole/protocol.h"

#include <inttypes.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#define GUAC_DISPLAY_DIAGNOSTICS_INTERVAL_US UINT64_C(10000000)

static pthread_once_t sample_key_once = PTHREAD_ONCE_INIT;
static pthread_key_t sample_key;
static int sample_key_ready;

typedef struct guac_display_diagnostics_slot {
    guac_display_render_sample* sample;
} guac_display_diagnostics_slot;

static void initialize_sample_key(void) {
    sample_key_ready = pthread_key_create(&sample_key, free) == 0;
}

static int initialize_samples(void) {
    return pthread_once(&sample_key_once, initialize_sample_key) == 0
        && sample_key_ready;
}

uint64_t guac_display_diagnostics_now(void) {
#if defined(HAVE_CLOCK_GETTIME) && defined(CLOCK_MONOTONIC)
    struct timespec current;
    if (clock_gettime(CLOCK_MONOTONIC, &current) == 0)
        return (uint64_t) current.tv_sec * UINT64_C(1000000)
            + current.tv_nsec / 1000;
    return 0;
#else
    /* Match libguac's portable clock fallback, retaining microsecond precision.
     * elapsed() prevents a backwards wall-clock adjustment wrapping counters. */
    struct timeval wall;
    if (gettimeofday(&wall, NULL) == 0)
        return (uint64_t) wall.tv_sec * UINT64_C(1000000) + wall.tv_usec;
    return 0;
#endif
}

uint64_t guac_display_diagnostics_elapsed(uint64_t start, uint64_t end) {
    return start != 0 && end >= start ? end - start : 0;
}

void guac_display_diagnostics_init(guac_display* display) {
    const char* setting = getenv(GUAC_DISPLAY_DIAGNOSTICS_ENV);
    int requested = setting != NULL && strcmp(setting, "1") == 0;
    display->diagnostics_enabled = requested && initialize_samples();
    display->diagnostics_valid = display->diagnostics_enabled;
    if (requested && !display->diagnostics_enabled)
        guac_client_log(display->client, GUAC_LOG_WARNING,
                "Display timing diagnostics unavailable: TLS initialization failed.");
    if (display->diagnostics_enabled) {
        display->diagnostics_last_log_us = guac_display_diagnostics_now();
        if (display->diagnostics_last_log_us == 0)
            guac_display_diagnostics_fail(display);
        guac_client_log(display->client, GUAC_LOG_DEBUG,
                "Display timing diagnostics enabled (numeric aggregates only).");
    }
}

int guac_display_diagnostics_set_current(guac_display_render_sample* sample) {
    if (!initialize_samples())
        return sample == NULL;
    guac_display_diagnostics_slot* slot = pthread_getspecific(sample_key);
    if (sample != NULL && slot == NULL) {
        slot = calloc(1, sizeof(*slot));
        if (slot == NULL)
            return 0;
        if (pthread_setspecific(sample_key, slot) != 0) {
            free(slot);
            return 0;
        }
    }
    /* A successful begin installs only the owning TLS slot. Ending a scope
     * never calls pthread_setspecific(), and cannot leave a stack pointer. */
    if (slot != NULL)
        slot->sample = sample;
    return 1;
}

guac_display_render_sample* guac_display_diagnostics_current(void) {
    if (!initialize_samples())
        return NULL;
    guac_display_diagnostics_slot* slot = pthread_getspecific(sample_key);
    return slot == NULL ? NULL : slot->sample;
}

static void add(uint64_t* value, uint64_t amount) {
    *value = amount > UINT64_MAX - *value ? UINT64_MAX : *value + amount;
}

int guac_display_diagnostics_send_blob_timed(guac_display_render_sample* sample,
        guac_socket* socket, guac_stream* stream, const void* data, int length) {
    uint64_t started = guac_display_diagnostics_now();
    int result = guac_protocol_send_blob(socket, stream, data, length);
    uint64_t finished = guac_display_diagnostics_now();
    if (started == 0 || finished == 0)
        sample->failed = 1;
    add(&sample->blob_send_us,
            guac_display_diagnostics_elapsed(started, finished));
    if (length > 0)
        add(&sample->encoded_bytes, (uint64_t) length);
    return result;
}

void guac_display_diagnostics_fail(guac_display* display) {
    if (display->diagnostics_valid) {
        display->diagnostics_valid = 0;
        guac_client_log(display->client, GUAC_LOG_WARNING,
                "Display timing diagnostics unavailable after clock/TLS failure.");
    }
}

void guac_display_diagnostics_record_image(guac_display* display,
        const guac_display_render_sample* sample) {
    if (sample->failed)
        guac_display_diagnostics_fail(display);
    uint64_t* stats = display->render_statistics;
    add(&stats[GUAC_DISPLAY_RENDER_IMAGES], 1);
    add(&stats[GUAC_DISPLAY_RENDER_PIXELS], sample->pixels);
    add(&stats[GUAC_DISPLAY_RENDER_QUEUE_US], sample->queue_us);
    add(&stats[GUAC_DISPLAY_RENDER_LOCK_WAIT_US], sample->lock_wait_us);
    add(&stats[GUAC_DISPLAY_RENDER_FORMAT_US], sample->format_us);
    add(&stats[GUAC_DISPLAY_RENDER_STREAM_US], sample->stream_us);
    add(&stats[GUAC_DISPLAY_RENDER_BLOB_SEND_US], sample->blob_send_us);
    add(&stats[GUAC_DISPLAY_RENDER_ENCODED_BYTES], sample->encoded_bytes);
    if (sample->queue_us > stats[GUAC_DISPLAY_RENDER_QUEUE_MAX_US])
        stats[GUAC_DISPLAY_RENDER_QUEUE_MAX_US] = sample->queue_us;
    if (sample->stream_us > stats[GUAC_DISPLAY_RENDER_STREAM_MAX_US])
        stats[GUAC_DISPLAY_RENDER_STREAM_MAX_US] = sample->stream_us;
    switch (sample->format) {
        case GUAC_DISPLAY_IMAGE_FORMAT_PNG:
            add(&stats[GUAC_DISPLAY_RENDER_PNG_IMAGES], 1);
            break;
        case GUAC_DISPLAY_IMAGE_FORMAT_JPEG:
            add(&stats[GUAC_DISPLAY_RENDER_JPEG_IMAGES], 1);
            break;
        case GUAC_DISPLAY_IMAGE_FORMAT_WEBP:
            add(&stats[GUAC_DISPLAY_RENDER_WEBP_IMAGES], 1);
            break;
    }
}

void guac_display_diagnostics_finish_frame(guac_display* display,
        uint64_t finish_started, uint64_t finished) {
    if (finish_started == 0 || finished == 0
            || display->diagnostics_batch_started_us == 0)
        guac_display_diagnostics_fail(display);
    uint64_t* stats = display->render_statistics;
    add(&stats[GUAC_DISPLAY_RENDER_FRAMES], 1);
    add(&stats[GUAC_DISPLAY_RENDER_FINISH_US],
            guac_display_diagnostics_elapsed(finish_started, finished));
    add(&stats[GUAC_DISPLAY_RENDER_FRAME_ELAPSED_US],
            guac_display_diagnostics_elapsed(display->diagnostics_batch_started_us, finished));
    display->diagnostics_batch_started_us = 0;

    if (!display->diagnostics_valid)
        return;
    if (guac_display_diagnostics_elapsed(display->diagnostics_last_log_us, finished)
            < GUAC_DISPLAY_DIAGNOSTICS_INTERVAL_US)
        return;
    display->diagnostics_last_log_us = finished;
    uint64_t images = stats[GUAC_DISPLAY_RENDER_IMAGES];
    uint64_t frames = stats[GUAC_DISPLAY_RENDER_FRAMES];
    guac_client_log(display->client, GUAC_LOG_DEBUG,
            "Display timing totals: frames=%" PRIu64 " images=%" PRIu64
            " png=%" PRIu64 " jpeg=%" PRIu64 " webp=%" PRIu64
            " bytes=%" PRIu64 " queue-mean-us=%" PRIu64 " queue-max-us=%" PRIu64
            " lock-mean-us=%" PRIu64 " format-mean-us=%" PRIu64
            " stream-mean-us=%" PRIu64 " stream-max-us=%" PRIu64
            " blob-send-mean-us=%" PRIu64 " finish-mean-us=%" PRIu64
            " frame-mean-us=%" PRIu64 ".",
            frames, images, stats[GUAC_DISPLAY_RENDER_PNG_IMAGES],
            stats[GUAC_DISPLAY_RENDER_JPEG_IMAGES], stats[GUAC_DISPLAY_RENDER_WEBP_IMAGES],
            stats[GUAC_DISPLAY_RENDER_ENCODED_BYTES],
            images ? stats[GUAC_DISPLAY_RENDER_QUEUE_US] / images : 0,
            stats[GUAC_DISPLAY_RENDER_QUEUE_MAX_US],
            images ? stats[GUAC_DISPLAY_RENDER_LOCK_WAIT_US] / images : 0,
            images ? stats[GUAC_DISPLAY_RENDER_FORMAT_US] / images : 0,
            images ? stats[GUAC_DISPLAY_RENDER_STREAM_US] / images : 0,
            stats[GUAC_DISPLAY_RENDER_STREAM_MAX_US],
            images ? stats[GUAC_DISPLAY_RENDER_BLOB_SEND_US] / images : 0,
            frames ? stats[GUAC_DISPLAY_RENDER_FINISH_US] / frames : 0,
            frames ? stats[GUAC_DISPLAY_RENDER_FRAME_ELAPSED_US] / frames : 0);
}

int guac_display_get_render_statistics(guac_display* display,
        uint64_t* values, size_t count) {
    if (display == NULL || count != GUAC_DISPLAY_RENDER_STATISTIC_COUNT || values == NULL
            || !display->diagnostics_enabled)
        return 0;
    guac_fifo_lock(&display->ops);
    if (!display->diagnostics_valid) {
        guac_fifo_unlock(&display->ops);
        return 0;
    }
    memcpy(values, display->render_statistics, sizeof(display->render_statistics));
    guac_fifo_unlock(&display->ops);
    return 1;
}
