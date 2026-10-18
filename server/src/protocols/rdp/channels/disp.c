/*
 * Modified for Greenmole by its maintainers.
 *
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

#include "channels/disp.h"
#include "plugins/channels.h"
#include "fs.h"
#include "rdp.h"
#include "settings.h"

#include <freerdp/client/disp.h>
#include <freerdp/freerdp.h>
#include <freerdp/event.h>
#include <guacamole/client.h>
#include <guacamole/mem.h>
#include <guacamole/rect.h>
#include <guacamole/timestamp.h>

#include <stdlib.h>
#include <string.h>

/** The caller holds the RDP client's recursive message lock. */
static void guac_rdp_disp_update_size_locked(guac_rdp_disp* disp,
        guac_rdp_settings* settings, freerdp* rdp_inst);

guac_rdp_disp* guac_rdp_disp_alloc(guac_client* client) {

    guac_rdp_disp* disp = guac_mem_alloc(sizeof(guac_rdp_disp));
    disp->client = client;

    /* Not yet connected */
    disp->disp = NULL;
    disp->rdp_inst = NULL;
    disp->caps_ready = 0;

    /* No requests have been made */
    disp->last_request = guac_timestamp_current();
    disp->requested_width  = 0;
    disp->requested_height = 0;
    disp->reconnect_needed = 0;

    return disp;

}

void guac_rdp_disp_free(guac_rdp_disp* disp) {
    guac_mem_free(disp);
}

/** Flush the latest queued viewport once the server permits layout updates. */
static UINT guac_rdp_disp_caps(DispClientContext* disp, UINT32 max_monitors,
        UINT32 area_factor_a, UINT32 area_factor_b) {
    guac_rdp_disp* guac_disp = (guac_rdp_disp*) disp->custom;
    guac_rdp_client* rdp_client = (guac_rdp_client*) guac_disp->client->data;
    pthread_mutex_lock(&rdp_client->message_lock);
    if (guac_disp->disp == disp) {
        guac_disp->caps_ready = 1;
        guac_client_log(guac_disp->client, GUAC_LOG_DEBUG,
                "Display update capabilities ready; pending viewport is %ix%i.",
                guac_disp->requested_width, guac_disp->requested_height);
        guac_rdp_disp_update_size_locked(guac_disp, rdp_client->settings,
                guac_disp->rdp_inst);
    }
    pthread_mutex_unlock(&rdp_client->message_lock);
    return CHANNEL_RC_OK;
}

/**
 * Callback which associates handlers specific to Guacamole with the
 * DispClientContext instance allocated by FreeRDP to deal with received
 * Display Update (client-initiated dynamic display resizing) messages.
 *
 * This function is called whenever a channel connects via the PubSub event
 * system within FreeRDP, but only has any effect if the connected channel is
 * the Display Update channel. This specific callback is registered with the
 * PubSub system of the relevant rdpContext when guac_rdp_disp_load_plugin() is
 * called.
 *
 * @param context
 *     The rdpContext associated with the active RDP session.
 *
 * @param args
 *     Event-specific arguments, mainly the name of the channel, and a
 *     reference to the associated plugin loaded for that channel by FreeRDP.
 */
static void guac_rdp_disp_channel_connected(rdpContext* context,
        ChannelConnectedEventArgs* args) {

    guac_client* client = ((rdp_freerdp_context*) context)->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;
    guac_rdp_disp* guac_disp = rdp_client->disp;

    /* Ignore connection event if it's not for the Display Update channel */
    if (strcmp(args->name, DISP_DVC_CHANNEL_NAME) != 0)
        return;

    /* Store reference to the display update plugin once it's connected */
    DispClientContext* disp = (DispClientContext*) args->pInterface;
    pthread_mutex_lock(&rdp_client->message_lock);
    guac_disp->disp = disp;
    /* FreeRDP owns the instance and channel until ChannelDisconnected, which
     * clears this borrow before the instance can be released. */
    guac_disp->rdp_inst = disp != NULL ? context->instance : NULL;
    guac_disp->caps_ready = 0;
    if (disp == NULL) {
        pthread_mutex_unlock(&rdp_client->message_lock);
        return;
    }
    disp->custom = guac_disp;
    disp->DisplayControlCaps = guac_rdp_disp_caps;

    /* The browser may have queued a newer viewport while RDP was connecting.
     * Seed from the negotiated size only if no request exists; otherwise keep
     * that latest viewport for the server capabilities callback. */
    if (guac_disp->requested_width == 0 || guac_disp->requested_height == 0)
        guac_rdp_disp_set_size(guac_disp, rdp_client->settings,
                context->instance, guac_rdp_get_width(context->instance),
                guac_rdp_get_height(context->instance));
    pthread_mutex_unlock(&rdp_client->message_lock);

    guac_client_log(client, GUAC_LOG_DEBUG, "Display update channel "
            "will be used for display size changes.");

}

/**
 * Callback which disassociates Guacamole from the DispClientContext instance
 * that was originally allocated by FreeRDP and is about to be deallocated.
 *
 * This function is called whenever a channel disconnects via the PubSub event
 * system within FreeRDP, but only has any effect if the disconnected channel
 * is the Display Update channel. This specific callback is registered with the
 * PubSub system of the relevant rdpContext when guac_rdp_disp_load_plugin() is
 * called.
 *
 * @param context
 *     The rdpContext associated with the active RDP session.
 *
 * @param args
 *     Event-specific arguments, mainly the name of the channel, and a
 *     reference to the associated plugin loaded for that channel by FreeRDP.
 */
static void guac_rdp_disp_channel_disconnected(rdpContext* context,
        ChannelDisconnectedEventArgs* args) {

    guac_client* client = ((rdp_freerdp_context*) context)->client;
    guac_rdp_client* rdp_client = (guac_rdp_client*) client->data;
    guac_rdp_disp* guac_disp = rdp_client->disp;

    /* Ignore disconnection event if it's not for the Display Update channel */
    if (strcmp(args->name, DISP_DVC_CHANNEL_NAME) != 0)
        return;

    /* Channel is no longer connected */
    pthread_mutex_lock(&rdp_client->message_lock);
    guac_disp->disp = NULL;
    guac_disp->rdp_inst = NULL;
    guac_disp->caps_ready = 0;
    pthread_mutex_unlock(&rdp_client->message_lock);

    guac_client_log(client, GUAC_LOG_DEBUG, "Display update channel "
            "disconnected.");

}

void guac_rdp_disp_load_plugin(rdpContext* context) {

    /* Subscribe to and handle channel connected events */
    PubSub_SubscribeChannelConnected(context->pubSub,
        (pChannelConnectedEventHandler) guac_rdp_disp_channel_connected);

    /* Subscribe to and handle channel disconnected events */
    PubSub_SubscribeChannelDisconnected(context->pubSub,
            (pChannelDisconnectedEventHandler) guac_rdp_disp_channel_disconnected);

    /* Add "disp" channel */
    guac_freerdp_dynamic_channel_collection_add(context->settings, "disp", NULL);

}

void guac_rdp_disp_set_size(guac_rdp_disp* disp, guac_rdp_settings* settings,
        freerdp* rdp_inst, int width, int height) {

    guac_rect resize = {
        .left = 0,
        .top = 0,
        .right = width,
        .bottom = height
    };

    /* Fit width and height within bounds, maintaining aspect ratio */
    guac_rect_shrink(&resize, GUAC_RDP_DISP_MAX_SIZE, GUAC_RDP_DISP_MAX_SIZE);

    width = guac_rect_width(&resize);
    height = guac_rect_height(&resize);

    /* As it's possible for a rectangle to exceed the maximum allowed
     * dimensions, yet fall below the minimum allowed dimensions once adjusted,
     * we don't bother preserving aspect ratio for the unlikely case that a
     * dimension is below the minimums (consider a rectangle like 16384x256) */
    if (width  < GUAC_RDP_DISP_MIN_SIZE) width  = GUAC_RDP_DISP_MIN_SIZE;
    if (height < GUAC_RDP_DISP_MIN_SIZE) height = GUAC_RDP_DISP_MIN_SIZE;

    /* Width must be even */
    if (width % 2 == 1)
        width -= 1;

    /* Store deferred size */
    guac_rdp_client* rdp_client = (guac_rdp_client*) disp->client->data;
    pthread_mutex_lock(&rdp_client->message_lock);
    disp->requested_width = width;
    disp->requested_height = height;

    /* Send display update notification if possible */
    guac_rdp_disp_update_size_locked(disp, settings, rdp_inst);
    pthread_mutex_unlock(&rdp_client->message_lock);

}

void guac_rdp_disp_update_size(guac_rdp_disp* disp,
        guac_rdp_settings* settings, freerdp* rdp_inst) {

    guac_rdp_client* rdp_client = (guac_rdp_client*) disp->client->data;
    pthread_mutex_lock(&rdp_client->message_lock);
    guac_rdp_disp_update_size_locked(disp, settings, rdp_inst);
    pthread_mutex_unlock(&rdp_client->message_lock);

}

static void guac_rdp_disp_update_size_locked(guac_rdp_disp* disp,
        guac_rdp_settings* settings, freerdp* rdp_inst) {

    int width = disp->requested_width;
    int height = disp->requested_height;

    /* Do not update size if no requests have been received */
    if (width == 0 || height == 0)
        return;

    guac_timestamp now = guac_timestamp_current();

    /* Limit display update frequency */
    if (now - disp->last_request <= GUAC_RDP_DISP_UPDATE_INTERVAL)
        return;

    /* Do NOT send requests unless the size will change */
    if (rdp_inst == NULL)
        rdp_inst = disp->rdp_inst;
    if (rdp_inst != NULL
            && width == guac_rdp_get_width(rdp_inst)
            && height == guac_rdp_get_height(rdp_inst))
        return;

    if (settings->resize_method == GUAC_RESIZE_RECONNECT) {

        disp->last_request = now;

        /* Update settings with new dimensions */
        settings->width = width;
        settings->height = height;

        /* Signal reconnect */
        disp->reconnect_needed = 1;

    }

    else if (settings->resize_method == GUAC_RESIZE_DISPLAY_UPDATE) {
        DISPLAY_CONTROL_MONITOR_LAYOUT monitors[1] = {{
            .Flags  = 0x1, /* DISPLAYCONTROL_MONITOR_PRIMARY */
            .Left = 0,
            .Top = 0,
            .Width  = width,
            .Height = height,
            .PhysicalWidth = 0,
            .PhysicalHeight = 0,
            .Orientation = 0,
            .DesktopScaleFactor = 0,
            .DeviceScaleFactor = 0
        }};

        /* The channel can open before server capabilities arrive. Preserve
         * the viewport until both stages of negotiation are complete. */
        if (disp->disp != NULL && disp->caps_ready) {

            /* A viewport deferred while the channel is opening must not use
             * up the send interval. Failed sends retain the requested size
             * and retry through the normal, rate-limited update loop. */
            disp->last_request = now;
            disp->disp->SendMonitorLayout(disp->disp, 1, monitors);

        }

    }

}

int guac_rdp_disp_reconnect_needed(guac_rdp_disp* disp) {
    guac_rdp_client* rdp_client = (guac_rdp_client*) disp->client->data;
    pthread_mutex_lock(&rdp_client->message_lock);
    int reconnect_needed = disp->reconnect_needed;
    pthread_mutex_unlock(&rdp_client->message_lock);

    /* Do not reconnect if files are open. */
    if (rdp_client->filesystem != NULL
            && rdp_client->filesystem->open_files > 0)
        return 0;

    /* Do not reconnect if an active print job is present */
    if (rdp_client->active_job != NULL)
        return 0;
    
    
    return reconnect_needed;
}

void guac_rdp_disp_reconnect_complete(guac_rdp_disp* disp) {
    guac_rdp_client* rdp_client = (guac_rdp_client*) disp->client->data;
    pthread_mutex_lock(&rdp_client->message_lock);
    disp->reconnect_needed = 0;
    disp->last_request = guac_timestamp_current();
    pthread_mutex_unlock(&rdp_client->message_lock);
}

