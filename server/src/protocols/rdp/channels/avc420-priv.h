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


#ifndef GUAC_RDP_AVC420_PRIV_H
#define GUAC_RDP_AVC420_PRIV_H
#include "channels/avc420.h"
#include <guacamole/stream.h>
#include <guacamole/timestamp.h>
#include <pthread.h>
#include <time.h>

typedef struct guac_rdp_avc420_pending {
    uint32_t sequence;
    size_t bytes;
    guac_timestamp sent;
} guac_rdp_avc420_pending;

struct guac_rdp_avc420 {
    pthread_mutex_t lock;
    pthread_cond_t ready_changed;
    int ready_monotonic;
    guac_user* owner;
    guac_stream* stream;
    int enabled, disabled, ready, presented, started, refresh, fallback_logged;
    int supported_frame, commands, image_pending;
    int avc444, stream_avc444;
    const char* reason;
    guac_timestamp opened;
    uint32_t sequence;
    size_t pending_bytes;
    unsigned int pending_count, pending_head;
    unsigned int pacing_events, pacing_logged;
    guac_timestamp last_pacing_log;
    guac_rdp_avc420_pending pending[GUAC_RDP_AVC420_MAX_PENDING];
    /* The following fields are confined to FreeRDP's graphics thread. */
    unsigned char* frame;
    size_t frame_length;
    unsigned int width, height;
    int frame_key, frame_aux_key, frame_avc444;
    uint32_t frame_main_length, frame_aux_length;
    pcRdpgfxMapSurfaceToOutput map_output;
    pcRdpgfxMapSurfaceToScaledOutput map_scaled_output;
    pcRdpgfxMapSurfaceToWindow map_window;
    pcRdpgfxMapSurfaceToScaledWindow map_scaled_window;
    pcRdpgfxDeleteEncodingContext delete_encoding;
    pcRdpgfxStartFrame start_frame;
    pcRdpgfxEndFrame end_frame;
    pcRdpgfxSurfaceCommand surface_command;
    pcRdpgfxResetGraphics reset_graphics;
    pcRdpgfxDeleteSurface delete_surface;
    pcRdpgfxSolidFill solid_fill;
    pcRdpgfxSurfaceToSurface surface_to_surface;
    pcRdpgfxCacheToSurface cache_to_surface;
};

void guac_rdp_avc420_send_frame(guac_client* client);
void guac_rdp_avc420_open(guac_client* client);
int guac_rdp_avc420_wait_ready(guac_client* client);
/** Waits with lock held, temporarily releasing it for independent ACKs. */
int guac_rdp_avc420_wait_changed(guac_rdp_avc420* video,
        const struct timespec* deadline);
/** Bounded FIFO credit wait. Never drops an H.264 access unit. */
int guac_rdp_avc420_wait_credit(guac_client* client);
/** Logs only internal state and fixed event/reason codes; lock must be held. */
void guac_rdp_avc420_log_state(guac_client* client, const char* event,
        const char* cause, guac_timestamp duration);

#endif
