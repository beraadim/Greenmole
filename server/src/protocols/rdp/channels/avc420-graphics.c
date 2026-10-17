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
#include "gdi.h"
#include "rdp.h"
#include <freerdp/gdi/gfx.h>
#include <freerdp/gdi/gdi.h>
#include <stdlib.h>
#include <string.h>

static guac_client* client_for(RdpgfxClientContext* gfx) {
    rdpGdi* gdi = gfx->custom;
    return ((rdp_freerdp_context*) gdi->context)->client;
}
static guac_rdp_avc420* video_for(guac_client* client) {
    return ((guac_rdp_client*) client->data)->avc420;
}


static UINT start_frame(RdpgfxClientContext* gfx, const RDPGFX_START_FRAME_PDU* frame) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420* video = video_for(client);
    pthread_mutex_lock(&video->lock);
    video->commands = 0;
    video->supported_frame = 1;
    pthread_mutex_unlock(&video->lock);
    free(video->frame);
    video->frame = NULL;
    video->frame_length = 0;
    guac_rdp_gdi_mark_frame(((rdpGdi*) gfx->custom)->context, 1);
    return video->start_frame(gfx, frame);
}

static UINT surface_command(RdpgfxClientContext* gfx, const RDPGFX_SURFACE_COMMAND* cmd) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420* video = video_for(client);
    rdpGdi* gdi = gfx->custom;
    gdiGfxSurface* surface = gfx->GetSurfaceData(gfx, cmd->surfaceId);
    RDPGFX_AVC420_BITMAP_STREAM* bs = cmd->extra;
    pthread_mutex_lock(&video->lock);
    video->commands++;
    int started = video->started;
    int enabled = video->enabled && !video->disabled;
    int single = video->commands == 1;
    pthread_mutex_unlock(&video->lock);
    int full = cmd->codecId == RDPGFX_CODECID_AVC420 && surface && bs
        && single && gdi->inGfxFrame && surface->outputMapped && !surface->windowId
        && !surface->outputOriginX && !surface->outputOriginY
        && surface->mappedWidth == (unsigned int) gdi->width
        && surface->mappedHeight == (unsigned int) gdi->height
        && surface->width == ((surface->mappedWidth + 15U) & ~15U)
        && surface->height == ((surface->mappedHeight + 15U) & ~15U)
        && surface->outputTargetWidth == surface->mappedWidth
        && surface->outputTargetHeight == surface->mappedHeight
        && surface->mappedWidth > 0 && surface->mappedHeight > 0
        && surface->mappedWidth <= 8192 && surface->mappedHeight <= 8192
        && (uint64_t) surface->mappedWidth * surface->mappedHeight <= 33554432U
        && !cmd->left && !cmd->top
        && cmd->right == surface->mappedWidth && cmd->bottom == surface->mappedHeight
        && bs->data && bs->length > 0 && bs->length <= GUAC_RDP_AVC420_MAX_FRAME
        && bs->meta.numRegionRects == 1 && bs->meta.regionRects
        && !bs->meta.regionRects[0].left && !bs->meta.regionRects[0].top
        && bs->meta.regionRects[0].right == surface->mappedWidth
        && bs->meta.regionRects[0].bottom == surface->mappedHeight;
    if (enabled && !full)
        guac_rdp_avc420_invalidate(client, "unsupported or mixed graphics surface command");
    /* Always retain FreeRDP's decoder, surface cache and frame ACK behavior.
     * Unsupported browsers therefore receive a complete ordinary image view. */
    UINT result = video->surface_command(gfx, cmd);
    if (result || !enabled || !full) return result;
    int key = guac_rdp_avc420_key_frame(bs->data, bs->length);
    if (!started && !key) return result;
    video->frame = malloc(bs->length);
    if (!video->frame) {
        guac_rdp_avc420_stop(client, "unable to allocate bounded AVC frame");
        return result;
    }
    memcpy(video->frame, bs->data, bs->length);
    video->frame_length = bs->length;
    video->frame_key = key;
    video->width = surface->mappedWidth;
    video->height = surface->mappedHeight;
    return result;
}

static UINT end_frame(RdpgfxClientContext* gfx, const RDPGFX_END_FRAME_PDU* frame) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420* video = video_for(client);
    UINT result = video->end_frame(gfx, frame);
    guac_rdp_gdi_mark_frame(((rdpGdi*) gfx->custom)->context, 0);
    if (result) guac_rdp_avc420_stop(client, "software graphics update failed");
    else guac_rdp_avc420_send_frame(client);
    pthread_mutex_lock(&video->lock);
    video->supported_frame = 0;
    video->commands = 0;
    pthread_mutex_unlock(&video->lock);
    return result;
}

static UINT reset_graphics(RdpgfxClientContext* gfx, const RDPGFX_RESET_GRAPHICS_PDU* reset) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics reset");
    return video_for(client)->reset_graphics(gfx, reset);
}
static UINT delete_surface(RdpgfxClientContext* gfx, const RDPGFX_DELETE_SURFACE_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics surface deleted");
    return video_for(client)->delete_surface(gfx, command);
}
static UINT solid_fill(RdpgfxClientContext* gfx, const RDPGFX_SOLID_FILL_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics fill operation");
    return video_for(client)->solid_fill(gfx, command);
}
static UINT surface_to_surface(RdpgfxClientContext* gfx, const RDPGFX_SURFACE_TO_SURFACE_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics surface copy operation");
    return video_for(client)->surface_to_surface(gfx, command);
}
static UINT cache_to_surface(RdpgfxClientContext* gfx, const RDPGFX_CACHE_TO_SURFACE_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics cache operation");
    return video_for(client)->cache_to_surface(gfx, command);
}

static UINT map_output(RdpgfxClientContext* gfx, const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics mapping or encoding context changed");
    return video_for(client)->map_output(gfx, command);
}
static UINT map_scaled_output(RdpgfxClientContext* gfx, const RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics mapping or encoding context changed");
    return video_for(client)->map_scaled_output(gfx, command);
}
static UINT map_window(RdpgfxClientContext* gfx, const RDPGFX_MAP_SURFACE_TO_WINDOW_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics mapping or encoding context changed");
    return video_for(client)->map_window(gfx, command);
}
static UINT map_scaled_window(RdpgfxClientContext* gfx, const RDPGFX_MAP_SURFACE_TO_SCALED_WINDOW_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics mapping or encoding context changed");
    return video_for(client)->map_scaled_window(gfx, command);
}
static UINT delete_encoding(RdpgfxClientContext* gfx, const RDPGFX_DELETE_ENCODING_CONTEXT_PDU* command) {
    guac_client* client = client_for(gfx);
    guac_rdp_avc420_invalidate(client, "graphics mapping or encoding context changed");
    return video_for(client)->delete_encoding(gfx, command);
}

void guac_rdp_avc420_init_graphics(guac_client* client, RdpgfxClientContext* gfx) {
    guac_rdp_avc420* video = video_for(client);
    if (!guac_rdp_avc420_enabled(client)) return;
    video->start_frame = gfx->StartFrame;
    video->end_frame = gfx->EndFrame;
    video->surface_command = gfx->SurfaceCommand;
    video->reset_graphics = gfx->ResetGraphics;
    video->delete_surface = gfx->DeleteSurface;
    video->solid_fill = gfx->SolidFill;
    video->surface_to_surface = gfx->SurfaceToSurface;
    video->cache_to_surface = gfx->CacheToSurface;
    video->map_output = gfx->MapSurfaceToOutput;
    gfx->MapSurfaceToOutput = map_output;
    video->map_scaled_output = gfx->MapSurfaceToScaledOutput;
    gfx->MapSurfaceToScaledOutput = map_scaled_output;
    video->map_window = gfx->MapSurfaceToWindow;
    gfx->MapSurfaceToWindow = map_window;
    video->map_scaled_window = gfx->MapSurfaceToScaledWindow;
    gfx->MapSurfaceToScaledWindow = map_scaled_window;
    video->delete_encoding = gfx->DeleteEncodingContext;
    gfx->DeleteEncodingContext = delete_encoding;
    gfx->StartFrame = start_frame;
    gfx->EndFrame = end_frame;
    gfx->SurfaceCommand = surface_command;
    gfx->ResetGraphics = reset_graphics;
    gfx->DeleteSurface = delete_surface;
    gfx->SolidFill = solid_fill;
    gfx->SurfaceToSurface = surface_to_surface;
    gfx->CacheToSurface = cache_to_surface;
}
