/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


#include "channels/avc420-priv.h"
#include "rdp.h"
#include <freerdp/gdi/gdi.h>
#include <guacamole/display.h>
#include <guacamole/mem.h>
#include <guacamole/protocol.h>
#include <guacamole/socket.h>
#include <inttypes.h>
#include <errno.h>
#include <time.h>
#include <stdlib.h>
#include <stdio.h>
#include <winpr/synch.h>
#include <string.h>

static guac_rdp_avc420* video_for(guac_client* client) {
    return ((guac_rdp_client*) client->data)->avc420;
}

guac_rdp_avc420* guac_rdp_avc420_alloc(void) {
    guac_rdp_avc420* video = guac_mem_zalloc(sizeof(*video));
    pthread_mutex_init(&video->lock, NULL);
    pthread_condattr_t ready_attributes;
    pthread_condattr_init(&ready_attributes);
#if defined(__linux__) && defined(CLOCK_MONOTONIC)
    video->ready_monotonic = !pthread_condattr_setclock(&ready_attributes, CLOCK_MONOTONIC);
#endif
    pthread_cond_init(&video->ready_changed, &ready_attributes);
    pthread_condattr_destroy(&ready_attributes);
    return video;
}

void guac_rdp_avc420_free(guac_rdp_avc420* video) {
    free(video->frame);
    pthread_cond_destroy(&video->ready_changed);
    pthread_mutex_destroy(&video->lock);
    guac_mem_free(video);
}

void guac_rdp_avc420_join(guac_client* client, guac_user* user) {
    guac_rdp_avc420* video = video_for(client);
    pthread_mutex_lock(&video->lock);
    if (!user->owner) {
        /* A shared viewer needs the normal image pipeline, irrespective of
         * its own decoder capabilities. Never expose an unsupported stream. */
        if (video->enabled && !video->disabled) {
            video->disabled = 1;
            video->refresh = 1;
            video->reason = "shared viewer joined";
            pthread_cond_broadcast(&video->ready_changed);
        }
    }
    else {
        const guac_rdp_settings* settings = user->data;
        const char** mime = user->info.video_mimetypes;
        int avc420 = 0, avc444 = 0;
        for (; mime && *mime; mime++) {
            avc420 |= !strcmp(*mime, GUAC_RDP_AVC420_MIMETYPE);
            avc444 |= !strcmp(*mime, GUAC_RDP_AVC444_MIMETYPE);
        }
        video->enabled = (avc420 || avc444) && settings->enable_gfx
            && (!settings->recording_path || !*settings->recording_path);
        video->avc444 = avc444;
        video->owner = user;
    }
    pthread_mutex_unlock(&video->lock);
}

void guac_rdp_avc420_leave(guac_client* client, guac_user* user) {
    guac_rdp_avc420* video = video_for(client);
    pthread_mutex_lock(&video->lock);
    if (video->owner == user) {
        video->disabled = 1;
        video->refresh = 1;
        video->reason = "video owner left";
        video->owner = NULL;
        pthread_cond_broadcast(&video->ready_changed);
        /* Guacamole owns/frees this user's streams with the user. */
        video->stream = NULL;
    }
    pthread_mutex_unlock(&video->lock);
}

int guac_rdp_avc420_enabled(guac_client* client) {
    guac_rdp_avc420* video = video_for(client);
    if (!video) return 0;
    pthread_mutex_lock(&video->lock);
    int enabled = video->enabled && !video->disabled;
    pthread_mutex_unlock(&video->lock);
    return enabled;
}

int guac_rdp_avc444_enabled(guac_client* client) {
    guac_rdp_avc420* video = video_for(client);
    if (!video) return 0;
    pthread_mutex_lock(&video->lock);
    int enabled = video->enabled && !video->disabled && video->avc444;
    pthread_mutex_unlock(&video->lock);
    return enabled;
}

void guac_rdp_avc420_stop(guac_client* client, const char* reason) {
    guac_rdp_avc420* video = video_for(client);
    if (!video) return;
    pthread_mutex_lock(&video->lock);
    if (video->enabled && !video->disabled) {
        video->disabled = 1;
        video->refresh = 1;
        video->reason = reason;
    }
    pthread_cond_broadcast(&video->ready_changed);
    pthread_mutex_unlock(&video->lock);
    /* Wake the RDP loop even when the desktop is idle. No RDP or display
     * locks may be acquired by the inbound ACK thread. */
    guac_rdp_client* rdp_client = client->data;
    if (rdp_client->input_event_queued)
        SetEvent(rdp_client->input_event_queued);
}

void guac_rdp_avc420_invalidate(guac_client* client, const char* reason) {
    guac_rdp_avc420* video = video_for(client);
    if (!video) return;
    pthread_mutex_lock(&video->lock);
    int started = video->started;
    video->supported_frame = 0;
    pthread_mutex_unlock(&video->lock);
    if (started) guac_rdp_avc420_stop(client, reason);
}

/**
 * Map only exact, content-free browser codes. Never retain or log peer text:
 * arbitrary ACK strings can contain desktop data or log-control characters.
 * Keep this list aligned with AVC444VideoPlayer.isFailureReason().
 */
static const char* avc444_failure_reason(const char* message) {
    static const struct { const char* ack; const char* reason; } reasons[] = {
        {"AVC444:fallback:invalid-stream", "browser AVC444 stream validation failed"},
        {"AVC444:fallback:unsupported-config", "browser AVC444 configuration unsupported"},
        {"AVC444:fallback:decoder-error", "browser AVC444 decoder error"},
        {"AVC444:fallback:native-layout", "browser AVC444 native YUV layout unsupported"},
        {"AVC444:fallback:native-copy", "browser AVC444 native YUV copy failed"},
        {"AVC444:fallback:renderer-error", "browser AVC444 reconstruction failed"},
        {"AVC444:fallback:context-lost", "browser AVC444 graphics context lost"},
        {"AVC444:fallback:frame-timeout", "browser AVC444 frame presentation deadline exceeded"},
        {"AVC444:fallback:assembly-timeout", "browser AVC444 frame assembly deadline exceeded"},
        {"AVC444:fallback:backlog-limit", "browser AVC444 queue safety limit exceeded"},
        {"AVC444:fallback:presentation-error", "browser AVC444 ordered presentation failed"}
    };
    for (size_t i = 0; i < sizeof(reasons) / sizeof(reasons[0]); i++)
        if (!strcmp(message, reasons[i].ack)) return reasons[i].reason;
    return NULL;
}

static int video_ack(guac_user* user, guac_stream* stream,
        char* message, guac_protocol_status status) {
    guac_rdp_avc420* video = video_for(user->client);
    int invalid = 0;
    const char* reason = "browser decoder rejected frame or invalid ACK";
    pthread_mutex_lock(&video->lock);
    if (video->stream != stream || video->disabled) {
        pthread_mutex_unlock(&video->lock);
        return 0;
    }
    const char* codec = video->stream_avc444 ? "AVC444" : "AVC420";
    char ready[32];
    snprintf(ready, sizeof(ready), "%s:ready", codec);
    if (status != GUAC_PROTOCOL_STATUS_SUCCESS) {
        invalid = 1;
        const char* failure = video->stream_avc444 ? avc444_failure_reason(message) : NULL;
        if (failure) reason = failure;
    }
    else if (!video->ready && !strcmp(message, ready)) {
        video->ready = 1;
        pthread_cond_broadcast(&video->ready_changed);
    }
    else if (video->ready && video->pending_count) {
        guac_rdp_avc420_pending* pending = &video->pending[video->pending_head];
        char expected[32];
        snprintf(expected, sizeof(expected), "%s:%" PRIu32, codec, pending->sequence);
        if (strcmp(expected, message))
            invalid = 1;
        else {
            video->pending_bytes -= pending->bytes;
            video->pending_head = (video->pending_head + 1) % GUAC_RDP_AVC420_MAX_PENDING;
            video->pending_count--;
            video->presented = 1;
        }
    }
    else invalid = 1;
    pthread_mutex_unlock(&video->lock);
    if (invalid)
        guac_rdp_avc420_stop(user->client, reason);
    return 0;
}

static void* open_for_owner(guac_user* user, void* data) {
    guac_client* client = data;
    guac_rdp_avc420* video = video_for(client);
    pthread_mutex_lock(&video->lock);
    if (user && user == video->owner && video->enabled
            && !video->disabled && !video->stream) {
        video->stream = guac_user_alloc_stream(user);
        if (video->stream) {
            video->stream->ack_handler = video_ack;
            /* Select the actual first frame's transport. An AVC444-capable
             * connection may still negotiate AVC420 when the host requests it. */
            video->stream_avc444 = video->frame_length
                ? video->frame_avc444 : video->avc444;
            video->opened = guac_timestamp_current();
            guac_protocol_send_video(user->socket, video->stream,
                    GUAC_DEFAULT_LAYER, video->stream_avc444
                        ? GUAC_RDP_AVC444_MIMETYPE : GUAC_RDP_AVC420_MIMETYPE);
            guac_socket_flush(user->socket);
            guac_client_log(client, GUAC_LOG_INFO,
                    "Experimental browser AVC%s decoder requested; retaining shadow GDI fallback.",
                    video->stream_avc444 ? "444" : "420");
        }
        else {
            video->disabled = video->refresh = 1;
            video->reason = "no available video stream";
        }
    }
    pthread_mutex_unlock(&video->lock);
    return NULL;
}

void guac_rdp_avc420_open(guac_client* client) {
    guac_client_for_owner(client, open_for_owner, client);
}

int guac_rdp_avc420_wait_ready(guac_client* client) {
    guac_rdp_avc420* video = video_for(client);
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    deadline.tv_sec += GUAC_RDP_AVC420_ACK_TIMEOUT / 1000;
    pthread_mutex_lock(&video->lock);
    /* Only the first IDR waits. The independent Guacamole ACK thread does
     * not acquire any FreeRDP/display locks and signals this condition. */
    while (!video->ready && !video->disabled) {
        if (video->ready_monotonic) {
            if (pthread_cond_timedwait(&video->ready_changed, &video->lock,
                        &deadline) == ETIMEDOUT)
                break;
        }
        else {
            /* Platforms without monotonic condition variables must not turn
             * a wall-clock rollback into an unbounded first-frame stall. */
            pthread_mutex_unlock(&video->lock);
            const struct timespec pause = { .tv_nsec = 10000000 };
            nanosleep(&pause, NULL);
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            pthread_mutex_lock(&video->lock);
            if (now.tv_sec > deadline.tv_sec || (now.tv_sec == deadline.tv_sec
                        && now.tv_nsec >= deadline.tv_nsec))
                break;
        }
    }
    int ready = video->ready && !video->disabled;
    pthread_mutex_unlock(&video->lock);
    if (!ready) guac_rdp_avc420_stop(client, "browser decoder ready deadline exceeded");
    return ready;
}

void guac_rdp_avc420_header(unsigned char header[20], uint32_t sequence,
        unsigned int width, unsigned int height, int key, uint32_t length) {
    uint32_t words[5] = {0x47415631U, sequence,
        (width << 16) | height, key ? 1U : 0U, length};
    for (unsigned int i = 0; i < 5; i++)
        for (unsigned int j = 0; j < 4; j++)
            header[i * 4 + j] = words[i] >> (24 - j * 8);
}

void guac_rdp_avc444_header(unsigned char header[32], uint32_t sequence,
        unsigned int width, unsigned int height, int main_key, int aux_key,
        uint32_t main_length, uint32_t aux_length) {
    uint32_t words[8] = {0x47415632U, sequence,
        (width << 16) | height,
        0x00010000U | (main_key ? 1U : 0U) | (aux_key ? 2U : 0U),
        main_length, aux_length, 0x00010001U, 0};
    for (unsigned int i = 0; i < 8; i++)
        for (unsigned int j = 0; j < 4; j++)
            header[i * 4 + j] = words[i] >> (24 - j * 8);
}

int guac_rdp_avc420_key_frame(const unsigned char* data, size_t length) {
    int types = 0;
    for (size_t i = 0; i + 3 < length; i++) {
        if (data[i] || data[i+1]) continue;
        size_t nal = i + 2;
        if (data[nal] == 0) nal++;
        if (nal + 1 >= length || data[nal] != 1) continue;
        switch (data[nal+1] & 31) {
            case 5: types |= 1; break;
            case 7: types |= 2; break;
            case 8: types |= 4; break;
        }
        i = nal;
    }
    return types == 7;
}

static void* send_for_owner(guac_user* user, void* data) {
    guac_client* client = data;
    guac_rdp_avc420* video = video_for(client);
    pthread_mutex_lock(&video->lock);
    if (!user || user != video->owner || video->disabled || !video->ready
            || !video->stream || !video->frame_length) goto done;
    if (video->pending_count >= GUAC_RDP_AVC420_MAX_PENDING
            || video->pending_bytes + video->frame_length > GUAC_RDP_AVC420_MAX_PENDING_BYTES
            || video->sequence == UINT32_MAX) {
        video->disabled = video->refresh = 1;
        video->reason = "browser video backlog limit";
        goto done;
    }
    uint32_t seq = ++video->sequence;
    unsigned char header[32];
    size_t header_length;
    if (video->stream_avc444) {
        guac_rdp_avc444_header(header, seq, video->width, video->height,
                video->frame_key, video->frame_aux_key,
                video->frame_main_length, video->frame_aux_length);
        header_length = 32;
    }
    else {
        guac_rdp_avc420_header(header, seq, video->width, video->height,
                video->frame_key, video->frame_length);
        header_length = 20;
    }
    guac_protocol_send_blob(user->socket, video->stream, header, header_length);
    for (size_t offset = 0; offset < video->frame_length; offset += 4096) {
        size_t chunk = video->frame_length - offset;
        if (chunk > 4096) chunk = 4096;
        guac_protocol_send_blob(user->socket, video->stream, video->frame + offset, chunk);
    }
    /* Every access unit closes a browser Display frame. This permits bounded
     * asynchronous decoding without waiting on a later desktop update. */
    guac_client_end_frame(client);
    guac_socket_flush(user->socket);
    unsigned int tail = (video->pending_head + video->pending_count) % GUAC_RDP_AVC420_MAX_PENDING;
    video->pending[tail] = (guac_rdp_avc420_pending) {
        .sequence = seq, .bytes = video->frame_length, .sent = guac_timestamp_current()
    };
    video->pending_count++;
    video->pending_bytes += video->frame_length;
    video->started = 1;
done:
    pthread_mutex_unlock(&video->lock);
    return NULL;
}

void guac_rdp_avc420_send_frame(guac_client* client) {
    guac_rdp_client* rdp_client = client->data;
    guac_rdp_avc420* video = video_for(client);
    if (!video->frame_length) return;
    /* Probationary image updates must be fully emitted before the matching
     * video. Otherwise a slow image worker could overwrite newer video pixels. */
    pthread_mutex_lock(&video->lock);
    int supported = video->supported_frame && video->commands == 1;
    int drain = !video->presented || video->image_pending;
    video->image_pending = 0;
    pthread_mutex_unlock(&video->lock);
    if (!supported) {
        free(video->frame);
        video->frame = NULL;
        video->frame_length = 0;
        return;
    }
    if (drain && !guac_display_flush_to_idle(rdp_client->display, 250))
        guac_rdp_avc420_stop(client, "image/video ordering barrier timed out");
    else {
        /* Initial size and image instructions must precede the video stream
         * itself. Opening during SurfaceCommand would put its first resize
         * after video, correctly causing the browser to dispose the decoder. */
        guac_rdp_avc420_open(client);
        if (guac_rdp_avc420_wait_ready(client))
            guac_client_for_owner(client, send_for_owner, client);
    }
    free(video->frame);
    video->frame = NULL;
    video->frame_length = 0;
}

int guac_rdp_avc420_suppress_paint(guac_client* client) {
    guac_rdp_avc420* video = video_for(client);
    if (!video) return 0;
    pthread_mutex_lock(&video->lock);
    if (video->enabled && !video->disabled && video->started && !video->supported_frame) {
        video->disabled = video->refresh = 1;
        video->reason = "image paint outside an AVC graphics frame";
    }
    int suppress = video->enabled && !video->disabled && video->presented
        && video->supported_frame && video->commands == 1;
    if (!suppress && video->enabled && !video->disabled)
        video->image_pending = 1;
    pthread_mutex_unlock(&video->lock);
    return suppress;
}

static void* close_for_owner(guac_user* user, void* data) {
    guac_rdp_avc420* video = video_for(data);
    pthread_mutex_lock(&video->lock);
    if (video->stream && user && user == video->owner) {
        guac_protocol_send_end(user->socket, video->stream);
        guac_socket_flush(user->socket);
        guac_user_free_stream(user, video->stream);
        video->stream = NULL;
    }
    pthread_mutex_unlock(&video->lock);
    return NULL;
}

void guac_rdp_avc420_poll(guac_client* client) {
    guac_rdp_client* rdp_client = client->data;
    guac_rdp_avc420* video = video_for(client);
    pthread_mutex_lock(&video->lock);
    guac_timestamp now = guac_timestamp_current();
    if (video->stream && !video->disabled
            && ((!video->ready && now - video->opened >= GUAC_RDP_AVC420_ACK_TIMEOUT)
                || (video->ready && !video->started && now - video->opened >= 10000)
                || (video->pending_count && now - video->pending[video->pending_head].sent
                    >= GUAC_RDP_AVC420_ACK_TIMEOUT))) {
        video->disabled = video->refresh = 1;
        video->reason = "browser video presentation deadline exceeded";
    }
    int refresh = video->refresh;
    video->refresh = 0;
    const char* reason = video->reason;
    int log = !video->fallback_logged;
    video->fallback_logged |= refresh;
    pthread_mutex_unlock(&video->lock);
    if (!refresh) return;
    guac_client_for_owner(client, close_for_owner, client);
    if (log) guac_client_log(client, GUAC_LOG_INFO,
            "Experimental browser AVC%s image fallback: %s.",
            video->stream_avc444 ? "444" : "420", reason);
    /* A full dirty rectangle reconciles Guacamole's image/cache baseline with
     * the continuously decoded shadow GDI, including changes hidden by video. */
    if (rdp_client->display && rdp_client->rdp_inst) {
        rdpGdi* gdi = GUAC_RDP_CONTEXT(rdp_client->rdp_inst)->gdi;
        guac_display_layer* layer = guac_display_default_layer(rdp_client->display);
        guac_display_layer_raw_context* context = guac_display_layer_open_raw(layer);
        context->buffer = gdi->primary_buffer;
        context->stride = gdi->stride;
        guac_rect_init(&context->bounds, 0, 0, gdi->width, gdi->height);
        context->dirty = context->bounds;
        guac_display_layer_close_raw(layer, context);
        rdp_client->gdi_modified = 1;
        /* Dirty tracking compares the shadow against the last IMAGE frame,
         * not the newer video visible in the browser. Even equal pixels must
         * be transmitted unconditionally, with the backing copy restored. */
        if (!guac_display_flush_to_idle(rdp_client->display, 250)
                || !guac_display_refresh(rdp_client->display, client->socket)) {
            pthread_mutex_lock(&video->lock);
            video->refresh = 1;
            pthread_mutex_unlock(&video->lock);
        }
    }
}
