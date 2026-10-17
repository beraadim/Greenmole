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

#include "display-diagnostics.h"
#include "encode-webp.h"
#include "guacamole/error.h"
#include "guacamole/protocol.h"
#include "guacamole/stream.h"
#include "palette.h"

#include <cairo/cairo.h>
#include <webp/encode.h>

#include <assert.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef GUAC_THREAD_LOCAL
static GUAC_THREAD_LOCAL guac_webp_workspace* guac_webp_current_workspace;
#endif

guac_webp_workspace* guac_webp_set_workspace(guac_webp_workspace* workspace) {
#ifdef GUAC_THREAD_LOCAL
    guac_webp_workspace* previous = guac_webp_current_workspace;
    guac_webp_current_workspace = workspace;
    return previous;
#else
    (void) workspace;
    return NULL;
#endif
}

void guac_webp_workspace_free(guac_webp_workspace* workspace) {
    if (workspace != NULL) {
        assert(!workspace->in_use);
        free(workspace->argb);
        memset(workspace, 0, sizeof(*workspace));
    }
}

/**
 * Prepares the same packed ARGB input as WebPPictureAlloc() plus the original
 * row copy. Only the worker's input allocation is reused; picture-owned codec
 * scratch is still released after every encode. Inputs are never zero-copy:
 * RGB24's unused byte must become opaque alpha, and ARGB32 remains untouched.
 */
static int guac_webp_prepare_picture(WebPPicture* picture, cairo_surface_t* surface,
        guac_webp_workspace* workspace, guac_webp_workspace** acquired) {
    int width = cairo_image_surface_get_width(surface);
    int height = cairo_image_surface_get_height(surface);
    int stride = cairo_image_surface_get_stride(surface);
    cairo_format_t format = cairo_image_surface_get_format(surface);
    const unsigned char* data = cairo_image_surface_get_data(surface);
    *acquired = NULL;
    if (cairo_surface_status(surface) || (format != CAIRO_FORMAT_RGB24 && format != CAIRO_FORMAT_ARGB32)
            || width <= 0 || height <= 0 || width > WEBP_MAX_DIMENSION || height > WEBP_MAX_DIMENSION
            || data == NULL || (stride < 0 ? -(int64_t) stride : (int64_t) stride)
                < (int64_t) width * (int) sizeof(uint32_t)) {
        guac_error = GUAC_STATUS_INVALID_ARGUMENT;
        guac_error_message = "Invalid Cairo image surface. Unable to create WebP.";
        return 0;
    }

    picture->use_argb = 1;
    picture->width = width;
    picture->height = height;
    size_t pixels = (size_t) width * (size_t) height;
    if (workspace != NULL && !workspace->in_use
            && pixels <= GUAC_WEBP_WORKSPACE_MAX_BYTES / sizeof(uint32_t)) {
        workspace->in_use = 1;
        if (pixels > workspace->capacity_pixels) {
            size_t capacity = workspace->capacity_pixels ? workspace->capacity_pixels : 4096;
            while (capacity < pixels) capacity *= 2;
            uint32_t* argb = realloc(workspace->argb, capacity * sizeof(uint32_t));
            if (argb == NULL) {
                workspace->in_use = 0;
            }
            else {
                workspace->argb = argb;
                workspace->capacity_pixels = capacity;
            }
        }
        if (workspace->in_use) {
            picture->argb = workspace->argb;
            picture->argb_stride = width;
            *acquired = workspace;
        }
    }
    /* Retention is optional: rounded cache growth may fail while the original
     * exact-sized transient allocation can still succeed. Keep the old cache
     * intact and try that path before failing the image. */
    if (*acquired == NULL && !WebPPictureAlloc(picture)) {
        guac_error = GUAC_STATUS_NO_MEMORY;
        guac_error_message = "Unable to allocate WebP input picture.";
        return 0;
    }

    uint32_t* output = picture->argb;
    for (int y = 0; y < height; y++) {
        const uint32_t* row = (const uint32_t*) data;
        if (format == CAIRO_FORMAT_ARGB32)
            memcpy(output, row, (size_t) width * sizeof(uint32_t));
        else {
            for (int x = 0; x < width; x++)
                output[x] = row[x] | UINT32_C(0xFF000000);
        }
        if (y + 1 < height) {
            data += stride;
            output += picture->argb_stride;
        }
    }
    return 1;
}

/**
 * Structure which describes the current state of the WebP image writer.
 */
typedef struct guac_webp_stream_writer {

    /**
     * The socket over which all WebP blobs will be written.
     */
    guac_socket* socket;

    /**
     * The Guacamole stream to associate with each WebP blob.
     */
    guac_stream* stream;

    /**
     * Buffer of pending WebP data.
     */
    char buffer[GUAC_PROTOCOL_BLOB_MAX_LENGTH];

    /**
     * The number of bytes currently stored in the buffer.
     */
    int buffer_size;

    /** Optional thread-confined numeric timing sample. */
    guac_display_render_sample* sample;

} guac_webp_stream_writer;

/**
 * Writes the contents of the WebP stream writer as a blob to its associated
 * socket.
 *
 * @param writer
 *     The writer structure to flush.
 */
static void guac_webp_flush_data(guac_webp_stream_writer* writer) {

    /* Send blob */
    guac_display_diagnostics_send_blob(writer->sample,
            writer->socket, writer->stream,
            writer->buffer, writer->buffer_size);

    /* Clear buffer */
    writer->buffer_size = 0;

}

/**
 * Configures the given stream writer object to use the given Guacamole stream
 * object for WebP output.
 *
 * @param writer
 *     The Guacamole WebP stream writer structure to configure.
 *
 * @param socket
 *     The Guacamole socket to use when sending blob instructions.
 *
 * @param stream
 *     The stream over which WebP-encoded blobs of image data should be sent.
 */
static void guac_webp_stream_writer_init(guac_webp_stream_writer* writer,
        guac_socket* socket, guac_stream* stream) {

    writer->buffer_size = 0;
    writer->sample = guac_display_diagnostics_current();

    /* Store Guacamole-specific objects */
    writer->socket = socket;
    writer->stream = stream;

}

/**
 * WebP output function which appends the given WebP data to the internal
 * buffer of the Guacamole stream writer structure, automatically flushing the
 * writer as necessary.
 *
 * @param data
 *     The segment of data to write.
 *
 * @param data_size
 *     The size of segment of data to write.
 *
 * @param picture
 *     The WebP picture associated with this write operation. Provides access to
 *     picture->custom_ptr which contains the Guacamole stream writer structure.
 *
 * @return
 *     Non-zero if writing was successful, zero on failure.
 */
static int guac_webp_stream_write(const uint8_t* data, size_t data_size,
        const WebPPicture* picture) {

    guac_webp_stream_writer* const writer =
        (guac_webp_stream_writer*) picture->custom_ptr;
    assert(writer != NULL);

    const unsigned char* current = data;
    int length = data_size;

    /* Append all data given */
    while (length > 0) {

        /* Calculate space remaining */
        int remaining = sizeof(writer->buffer) - writer->buffer_size;

        /* If no space remains, flush buffer to make room */
        if (remaining == 0) {
            guac_webp_flush_data(writer);
            remaining = sizeof(writer->buffer);
        }

        /* Calculate size of next block of data to append */
        int block_size = remaining;
        if (block_size > length)
            block_size = length;

        /* Append block */
        memcpy(writer->buffer + writer->buffer_size,
               current, block_size);

        /* Next block */
        current += block_size;
        writer->buffer_size += block_size;
        length -= block_size;

    }

    return 1;
}

int guac_webp_write(guac_socket* socket, guac_stream* stream,
        cairo_surface_t* surface, int quality, int lossless) {

    guac_webp_stream_writer writer;
    WebPPicture picture;

    /* Flush pending operations to surface */
    cairo_surface_flush(surface);

    /* Configure WebP compression bits */
    WebPConfig config;
    if (!WebPConfigPreset(&config, WEBP_PRESET_DEFAULT, quality))
        return -1;

    /* Add additional tuning */
    config.lossless = lossless;
    config.quality = quality;
    config.thread_level = 0; /* NOT multi-threaded (threading results in unnecessary overhead vs. the worker threads used by guac_display) */
    config.method = 2; /* Compression method (0=fast/larger, 6=slow/smaller) */

    /* Validate configuration */
    if (!WebPValidateConfig(&config)) {
        return -1;
    }

    /* Set up WebP picture */
    if (!WebPPictureInit(&picture)) {
        return -1;
    }
    guac_webp_workspace* workspace = NULL;
#ifdef GUAC_THREAD_LOCAL
    workspace = guac_webp_current_workspace;
#endif
    guac_webp_workspace* acquired;
    if (!guac_webp_prepare_picture(&picture, surface, workspace, &acquired)) {
        WebPPictureFree(&picture);
        return -1;
    }
    picture.writer = guac_webp_stream_write;
    picture.custom_ptr = &writer;
    guac_webp_stream_writer_init(&writer, socket, stream);

    /* Encode image */
    const int result = WebPEncode(&config, &picture) ? 0 : -1;

    /* Free picture */
    WebPPictureFree(&picture);

    /* Ensure all data is written */
    guac_webp_flush_data(&writer);

    if (acquired != NULL)
        acquired->in_use = 0;

    return result;

}

