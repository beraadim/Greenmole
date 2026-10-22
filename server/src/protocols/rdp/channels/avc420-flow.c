/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "channels/avc420-priv.h"
#include "rdp.h"
#include <inttypes.h>
#include <limits.h>

int guac_rdp_avc420_wait_changed(guac_rdp_avc420* video,
        const struct timespec* deadline) {
    if (video->ready_monotonic)
        return !pthread_cond_timedwait(&video->ready_changed, &video->lock,
                deadline);

    /* Wall-clock changes must not extend the deadline on platforms without
     * monotonic condition variables. Reacquire before inspecting any state. */
    pthread_mutex_unlock(&video->lock);
    const struct timespec pause = { .tv_nsec = 10000000 };
    nanosleep(&pause, NULL);
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    pthread_mutex_lock(&video->lock);
    return now.tv_sec < deadline->tv_sec || (now.tv_sec == deadline->tv_sec
            && now.tv_nsec < deadline->tv_nsec);
}

void guac_rdp_avc420_log_state(guac_client* client, const char* event,
        const char* cause, guac_timestamp duration) {
    guac_rdp_avc420* video = ((guac_rdp_client*) client->data)->avc420;
    guac_timestamp now = guac_timestamp_current();
    guac_timestamp oldest = video->pending_count
        ? now - video->pending[video->pending_head].sent : 0;
    guac_client_log(client, GUAC_LOG_INFO,
            "Experimental browser AVC%s %s: cause=%s ready=%i presented=%i "
            "pending_frames=%u pending_bytes=%zu oldest_ms=%" PRId64
            " opened_ms=%" PRId64 " duration_ms=%" PRId64 " pacing_events=%u.",
            video->stream_avc444 ? "444" : "420", event, cause,
            video->ready, video->presented, video->pending_count,
            video->pending_bytes, oldest > 0 ? oldest : 0,
            video->opened ? now - video->opened : 0,
            duration, video->pacing_events);
}

static unsigned int window_for(const guac_rdp_avc420* video) {
    /* Multiple decoder inputs avoid relying on hardware output after just an
     * IDR. Startup matches browser decode slots; presentation earns a larger
     * steady window without filling the browser's hard safety queue. */
    if (video->stream_avc444) return video->presented ? 4 : 2;
    return video->presented ? 8 : 4;
}

static const char* pressure_for(const guac_rdp_avc420* video) {
    if (video->pending_bytes > GUAC_RDP_AVC420_MAX_PENDING_BYTES
            || video->frame_length > GUAC_RDP_AVC420_MAX_PENDING_BYTES
                - video->pending_bytes)
        return "byte-window";
    if (video->pending_count >= window_for(video))
        return video->presented ? "steady-window" : "startup-window";
    return NULL;
}

int guac_rdp_avc420_wait_credit(guac_client* client) {
    guac_rdp_avc420* video = ((guac_rdp_client*) client->data)->avc420;
    pthread_mutex_lock(&video->lock);
    if (video->disabled || !video->ready || !video->stream) {
        pthread_mutex_unlock(&video->lock);
        return 0;
    }
    guac_timestamp started = guac_timestamp_current();
    if (video->pending_count && started - video->pending[video->pending_head].sent
            >= GUAC_RDP_AVC420_ACK_TIMEOUT) {
        video->disabled = video->refresh = 1;
        video->reason = "browser video presentation deadline exceeded";
        pthread_cond_broadcast(&video->ready_changed);
        pthread_mutex_unlock(&video->lock);
        return 0;
    }
    const char* pressure = pressure_for(video);
    if (!pressure) {
        pthread_mutex_unlock(&video->lock);
        return 1;
    }
    if (video->pacing_events < UINT_MAX) video->pacing_events++;
    /* Log the first three episodes, then at most once per thirty seconds.
     * Normal credit turnover can occur every few frames and is not a warning. */
    int log = video->pacing_logged < 3
        || started - video->last_pacing_log >= 30000;
    if (log) {
        if (video->pacing_logged < UINT_MAX) video->pacing_logged++;
        video->last_pacing_log = started;
        guac_rdp_avc420_log_state(client, "pacing-wait", pressure, 0);
    }
    guac_timestamp remaining = video->pending_count
        ? GUAC_RDP_AVC420_ACK_TIMEOUT
            - (guac_timestamp_current() - video->pending[video->pending_head].sent) : 0;
    if (remaining > GUAC_RDP_AVC420_ACK_TIMEOUT)
        remaining = GUAC_RDP_AVC420_ACK_TIMEOUT;
    struct timespec deadline;
    clock_gettime(CLOCK_MONOTONIC, &deadline);
    if (remaining > 0) {
        deadline.tv_sec += remaining / 1000;
        deadline.tv_nsec += (remaining % 1000) * 1000000;
        if (deadline.tv_nsec >= 1000000000) {
            deadline.tv_sec++;
            deadline.tv_nsec -= 1000000000;
        }
    }
    int expired = remaining <= 0;
    /* Wait outside guac_client_for_owner(): neither user lifetime locks nor
     * the video mutex may prevent the independent inbound ACK/leave thread.
     * No dependent H.264 picture is skipped or retained in another queue. */
    while (!video->disabled && pressure_for(video) && !expired)
        expired = !guac_rdp_avc420_wait_changed(video, &deadline);
    int admitted = !video->disabled && !expired && !pressure_for(video);
    if (!admitted && !video->disabled) {
        video->disabled = video->refresh = 1;
        video->reason = "browser video pacing presentation deadline exceeded";
        pthread_cond_broadcast(&video->ready_changed);
    }
    if (log)
        guac_rdp_avc420_log_state(client, "pacing-result",
                admitted ? "recovered" : (expired ? "deadline" : "cancelled"),
                guac_timestamp_current() - started);
    pthread_mutex_unlock(&video->lock);
    return admitted;
}
