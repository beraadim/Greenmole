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

#ifndef GUAC_RDP_AVC420_H
#define GUAC_RDP_AVC420_H

#include <freerdp/client/rdpgfx.h>
#include <guacamole/client.h>
#include <guacamole/user.h>
#include <stddef.h>
#include <stdint.h>

#define GUAC_RDP_AVC420_MIMETYPE "video/x-guacamole-avc420;v=1"
#define GUAC_RDP_AVC420_MAX_FRAME (8U * 1024U * 1024U)
#define GUAC_RDP_AVC420_MAX_PENDING 16
#define GUAC_RDP_AVC420_MAX_PENDING_BYTES (16U * 1024U * 1024U)
#define GUAC_RDP_AVC420_ACK_TIMEOUT 2000

/** Opaque, per-connection experimental browser video state. */
typedef struct guac_rdp_avc420 guac_rdp_avc420;

guac_rdp_avc420* guac_rdp_avc420_alloc(void);
void guac_rdp_avc420_free(guac_rdp_avc420* video);
void guac_rdp_avc420_join(guac_client* client, guac_user* user);
void guac_rdp_avc420_leave(guac_client* client, guac_user* user);
int guac_rdp_avc420_enabled(guac_client* client);
void guac_rdp_avc420_init_graphics(guac_client* client, RdpgfxClientContext* gfx);
void guac_rdp_avc420_stop(guac_client* client, const char* reason);
void guac_rdp_avc420_invalidate(guac_client* client, const char* reason);
void guac_rdp_avc420_poll(guac_client* client);
int guac_rdp_avc420_suppress_paint(guac_client* client);

/** Validates Annex B framing; a key frame must carry SPS, PPS and an IDR. */
int guac_rdp_avc420_key_frame(const unsigned char* data, size_t length);
/** Serializes the versioned network-order frame header. */
void guac_rdp_avc420_header(unsigned char header[20], uint32_t sequence,
        unsigned int width, unsigned int height, int key, uint32_t length);

#endif
