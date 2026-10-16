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

#ifndef GUAC_DISPLAY_DIAGNOSTICS_H
#define GUAC_DISPLAY_DIAGNOSTICS_H

#include "guacamole/display-types.h"
#include "guacamole/protocol.h"
#include "guacamole/socket-types.h"
#include "guacamole/stream-types.h"

#include <stddef.h>
#include <stdint.h>

/** Administrative, session-initialization-only opt-in; only "1" enables. */
#define GUAC_DISPLAY_DIAGNOSTICS_ENV "GUAC_DISPLAY_DIAGNOSTICS"

/** Private cumulative counters. Durations are wall microseconds, not CPU time.
 * Worker sums overlap when encoders run concurrently; BLOB_SEND_US is a subset
 * of STREAM_US. The final two slots are lifetime maxima, not counters. */
typedef enum guac_display_render_statistic {
    GUAC_DISPLAY_RENDER_IMAGES,
    GUAC_DISPLAY_RENDER_PIXELS,
    GUAC_DISPLAY_RENDER_QUEUE_US,
    GUAC_DISPLAY_RENDER_LOCK_WAIT_US,
    GUAC_DISPLAY_RENDER_FORMAT_US,
    GUAC_DISPLAY_RENDER_STREAM_US,
    GUAC_DISPLAY_RENDER_BLOB_SEND_US,
    GUAC_DISPLAY_RENDER_ENCODED_BYTES,
    GUAC_DISPLAY_RENDER_PNG_IMAGES,
    GUAC_DISPLAY_RENDER_JPEG_IMAGES,
    GUAC_DISPLAY_RENDER_WEBP_IMAGES,
    GUAC_DISPLAY_RENDER_FRAMES,
    GUAC_DISPLAY_RENDER_FINISH_US,
    GUAC_DISPLAY_RENDER_FRAME_ELAPSED_US,
    GUAC_DISPLAY_RENDER_QUEUE_MAX_US,
    GUAC_DISPLAY_RENDER_STREAM_MAX_US,
    GUAC_DISPLAY_RENDER_STATISTIC_COUNT
} guac_display_render_statistic;

/** Stack-owned, thread-confined sample. Never retains image data. */
typedef struct guac_display_render_sample {
    uint64_t queue_us;
    uint64_t lock_wait_us;
    uint64_t format_us;
    uint64_t stream_us;
    uint64_t blob_send_us;
    uint64_t encoded_bytes;
    uint64_t pixels;
    int format;
    int failed;
} guac_display_render_sample;

/** Reads the opt-in once, before workers start. Failure disables diagnostics. */
void guac_display_diagnostics_init(guac_display* display);

/** Monotonic microseconds where supported; otherwise wall time, clipped by elapsed(). */
uint64_t guac_display_diagnostics_now(void);
uint64_t guac_display_diagnostics_elapsed(uint64_t start, uint64_t end);

/** Associates a stack sample with the current worker's synchronous encoder.
 * NULL clears it without a fallible pthread_setspecific() operation. Returns
 * zero if initial TLS slot allocation/installation failed. At most one small
 * slot is allocated per participating thread and freed by its TLS destructor.
 * No sample is inherited by another thread or display. */
int guac_display_diagnostics_set_current(guac_display_render_sample* sample);
guac_display_render_sample* guac_display_diagnostics_current(void);

/** Sends an unchanged blob, optionally timing protocol serialization/socket
 * work. Disabled samples incur no clock reads and preserve the return code. */
int guac_display_diagnostics_send_blob_timed(guac_display_render_sample* sample,
        guac_socket* socket, guac_stream* stream, const void* data, int length);

static inline int guac_display_diagnostics_send_blob(guac_display_render_sample* sample,
        guac_socket* socket, guac_stream* stream, const void* data, int length) {
    /* Keep the default path as a direct call to the existing protocol helper. */
    return sample == NULL ? guac_protocol_send_blob(socket, stream, data, length)
        : guac_display_diagnostics_send_blob_timed(sample, socket, stream, data, length);
}

/** FIFO lock must be held. Publication precedes active_workers reaching zero. */
void guac_display_diagnostics_fail(guac_display* display);
void guac_display_diagnostics_record_image(guac_display* display,
        const guac_display_render_sample* sample);
void guac_display_diagnostics_finish_frame(guac_display* display,
        uint64_t finish_started, uint64_t finished);

/** Copies exactly STATISTIC_COUNT slots under the FIFO lock. Returns 1 for an
 * enabled complete snapshot; 0 if disabled, a clock/TLS failure occurred, or
 * count is wrong, without modifying values.
 * This private diagnostics interface is not part of installed libguac API. */
int guac_display_get_render_statistics(guac_display* display,
        uint64_t* values, size_t count);

#endif
