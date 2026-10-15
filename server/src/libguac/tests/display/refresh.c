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

#include <CUnit/CUnit.h>

#include "../../display-priv.h"
#include "../../user-handlers.h"
#include "guacamole/client.h"
#include "guacamole/display.h"
#include "guacamole/layer.h"
#include "guacamole/mem.h"
#include "guacamole/parser.h"
#include "guacamole/protocol.h"
#include "guacamole/socket.h"
#include "guacamole/timestamp.h"
#include "guacamole/user.h"

#include <cairo/cairo.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int refresh_calls;
static guac_user* refreshed_user;

static int refresh_handler(guac_user* user) {
    refresh_calls++;
    refreshed_user = user;
    return 17;
}

/** Unsupported protocols must ignore even a correctly formed request. */
void test_display__refresh_requires_protocol_support() {
    guac_user user = { 0 };
    char* args[] = { "1", "request" };
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 2, args), 0);
    CU_ASSERT_EQUAL(user.display_refresh_requested, 0);
}

/** Incorrect counts, versions, and actions cannot trigger an expensive send. */
void test_display__refresh_rejects_malformed_requests() {
    guac_user user = { .display_refresh_handler = refresh_handler };
    refresh_calls = 0;
    char* valid[] = { "1", "request" };
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 0, NULL), 0);
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 1, valid), 0);
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 3, NULL), 0);

    char* invalid[][2] = {
        { "", "request" }, { "01", "request" }, { "2", "request" },
        { "1", "" }, { "1", "Request" }, { "1", "ready" },
        { "1", "request,extra" }
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++)
        CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 2, invalid[i]), 0);
    CU_ASSERT_EQUAL(refresh_calls, 0);
    CU_ASSERT_EQUAL(user.display_refresh_requested, 0);
}

/** Rate limiting is per user, including non-owner users viewing a session. */
void test_display__refresh_limits_each_user_independently() {
    guac_user first = { .display_refresh_handler = refresh_handler };
    guac_user second = { .display_refresh_handler = refresh_handler };
    char* args[] = { "1", "request" };
    refresh_calls = 0;
    refreshed_user = NULL;
    CU_ASSERT_EQUAL(__guac_user_call_opcode_handler(__guac_instruction_handler_map,
                &first, "x-resync", 2, args), 17);
    CU_ASSERT_PTR_EQUAL(refreshed_user, &first);
    CU_ASSERT_EQUAL(first.display_refresh_requested, 1);
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&first, 2, args), 0);
    CU_ASSERT_EQUAL(refresh_calls, 1);
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&second, 2, args), 17);
    CU_ASSERT_PTR_EQUAL(refreshed_user, &second);
    CU_ASSERT_EQUAL(refresh_calls, 2);
}

/** A later permitted request works, including the wall-clock fallback case. */
void test_display__refresh_rate_limit_expires() {
    guac_user user = {
        .display_refresh_handler = refresh_handler,
        .display_refresh_requested = 1,
        .last_display_refresh = guac_timestamp_current() - 6000
    };
    char* args[] = { "1", "request" };
    refresh_calls = 0;
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 2, args), 17);
    CU_ASSERT_EQUAL(refresh_calls, 1);
    user.last_display_refresh = guac_timestamp_current() + 6000;
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 2, args), 17);
    CU_ASSERT_EQUAL(refresh_calls, 2);
    CU_ASSERT_EQUAL(__guac_handle_display_refresh(&user, 2, args), 0);
    CU_ASSERT_EQUAL(refresh_calls, 2);
}

/** An in-memory transport allows real protocol serialization to be parsed. */
typedef struct refresh_sink {
    char buffer[8192];
    size_t length;
} refresh_sink;

static ssize_t refresh_write(guac_socket* socket, const void* buffer, size_t count) {
    refresh_sink* sink = socket->data;
    if (count > sizeof(sink->buffer) - sink->length)
        return -1;
    memcpy(sink->buffer + sink->length, buffer, count);
    sink->length += count;
    return count;
}

static guac_socket* refresh_socket(refresh_sink* sink) {
    guac_socket* socket = guac_socket_alloc();
    if (socket != NULL) {
        socket->data = sink;
        socket->write_handler = refresh_write;
    }
    return socket;
}

/** Advertisements/results must carry the exact versioned private opcode. */
void test_display__refresh_protocol_serialization() {
    refresh_sink sink = { 0 };
    guac_socket* socket = refresh_socket(&sink);
    CU_ASSERT_PTR_NOT_NULL_FATAL(socket);
    CU_ASSERT_EQUAL(guac_protocol_send_display_refresh(socket, "ready"), 0);
    CU_ASSERT_EQUAL(guac_protocol_send_display_refresh(socket, "busy"), 0);
    CU_ASSERT_EQUAL(guac_protocol_send_display_refresh(socket, "done"), 0);
    const char* expected = "8.x-resync,1.1,5.ready;8.x-resync,1.1,4.busy;"
        "8.x-resync,1.1,4.done;";
    CU_ASSERT_EQUAL(sink.length, strlen(expected));
    if (sink.length == strlen(expected))
        CU_ASSERT_EQUAL(memcmp(sink.buffer, expected, sink.length), 0);
    guac_socket_free(socket);
}

/** The busy path must send nothing and release both locks before returning. */
void test_display__refresh_busy_sends_nothing_and_releases_locks() {
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    guac_rwlock_init(&display->last_frame.lock);
    guac_flag_init(&display->render_state);
    refresh_sink sink = { 0 };
    guac_socket* socket = refresh_socket(&sink);
    CU_ASSERT_PTR_NOT_NULL_FATAL(socket);
    CU_ASSERT_EQUAL(guac_display_refresh(display, socket), 0);
    CU_ASSERT_EQUAL(sink.length, 0);
    int locked = pthread_rwlock_trywrlock(&display->last_frame.lock);
    CU_ASSERT_EQUAL(locked, 0);
    if (!locked)
        pthread_rwlock_unlock(&display->last_frame.lock);
    locked = pthread_mutex_trylock(&display->render_state.value_mutex);
    CU_ASSERT_EQUAL(locked, 0);
    if (!locked)
        pthread_mutex_unlock(&display->render_state.value_mutex);
    guac_socket_free(socket);
    guac_flag_destroy(&display->render_state);
    guac_rwlock_destroy(&display->last_frame.lock);
    guac_mem_free(display);
}

typedef struct refresh_png {
    const unsigned char* data;
    size_t remaining;
} refresh_png;

static cairo_status_t refresh_read_png(void* closure, unsigned char* output,
        unsigned int length) {
    refresh_png* png = closure;
    if (length > png->remaining)
        return CAIRO_STATUS_READ_ERROR;
    memcpy(output, png->data, length);
    png->data += length;
    png->remaining -= length;
    return CAIRO_STATUS_SUCCESS;
}

/** Verify the actual snapshot instruction stream and its lossless PNG pixels. */
static void verify_refresh_snapshot(refresh_sink* sink, guac_composite_mode mode) {
    size_t offset = 0;
    int images = 0;
    int copies = 0;
    int pngs = 0;
    int syncs = 0;
    while (offset < sink->length) {
        guac_parser* parser = guac_parser_alloc();
        CU_ASSERT_PTR_NOT_NULL_FATAL(parser);
        /* append() advances one element at a time, even if the full
         * instruction is already present. Continue until its semicolon. */
        while (parser->state != GUAC_PARSE_COMPLETE) {
            CU_ASSERT_TRUE_FATAL(offset < sink->length);
            int consumed = guac_parser_append(parser, sink->buffer + offset,
                    sink->length - offset);
            CU_ASSERT_TRUE_FATAL(consumed > 0);
            CU_ASSERT_NOT_EQUAL_FATAL(parser->state, GUAC_PARSE_ERROR);
            offset += consumed;
        }
        if (!strcmp(parser->opcode, "size")) {
            CU_ASSERT_EQUAL_FATAL(parser->argc, 3);
            CU_ASSERT_STRING_EQUAL(parser->argv[1], "2");
            CU_ASSERT_STRING_EQUAL(parser->argv[2], "1");
        }
        else if (!strcmp(parser->opcode, "img")) {
            images++;
            CU_ASSERT_EQUAL_FATAL(parser->argc, 6);
            CU_ASSERT_EQUAL(atoi(parser->argv[1]), mode);
            CU_ASSERT_STRING_EQUAL(parser->argv[2], "0");
            CU_ASSERT_STRING_EQUAL(parser->argv[3], "image/png");
        }
        else if (!strcmp(parser->opcode, "blob")) {
            pngs++;
            CU_ASSERT_EQUAL_FATAL(parser->argc, 2);
            refresh_png png = {
                .data = (const unsigned char*) parser->argv[1],
                .remaining = guac_protocol_decode_base64(parser->argv[1])
            };
            cairo_surface_t* surface = cairo_image_surface_create_from_png_stream(
                    refresh_read_png, &png);
            CU_ASSERT_EQUAL_FATAL(cairo_surface_status(surface), CAIRO_STATUS_SUCCESS);
            CU_ASSERT_EQUAL(cairo_image_surface_get_width(surface), 2);
            CU_ASSERT_EQUAL(cairo_image_surface_get_height(surface), 1);
            uint32_t* pixels = (uint32_t*) cairo_image_surface_get_data(surface);
            CU_ASSERT_EQUAL(pixels[0], 0);
            CU_ASSERT_EQUAL(pixels[1], 0x80800000U);
            cairo_surface_destroy(surface);
        }
        else if (!strcmp(parser->opcode, "copy")) {
            copies++;
            CU_ASSERT_EQUAL_FATAL(parser->argc, 9);
            CU_ASSERT_EQUAL(atoi(parser->argv[5]), mode);
            CU_ASSERT_STRING_EQUAL(parser->argv[6], "-1");
        }
        else if (!strcmp(parser->opcode, "sync")) {
            syncs++;
            CU_ASSERT_EQUAL_FATAL(parser->argc, 2);
            CU_ASSERT_STRING_EQUAL(parser->argv[0], "1234");
            CU_ASSERT_STRING_EQUAL(parser->argv[1], "3");
            CU_ASSERT_EQUAL(offset, sink->length);
        }
        guac_parser_free(parser);
    }
    CU_ASSERT_EQUAL(images, 1);
    CU_ASSERT_EQUAL(copies, 1);
    CU_ASSERT_EQUAL(pngs, 1);
    CU_ASSERT_EQUAL(syncs, 1);
}

/** Recovery replaces committed alpha pixels for only the requesting user. */
void test_display__refresh_targets_one_user_and_preserves_committed_pixels() {
    guac_client* client = guac_client_alloc();
    CU_ASSERT_PTR_NOT_NULL_FATAL(client);
    client->last_sent_timestamp = 1234;
    guac_display* display = guac_mem_zalloc(sizeof(guac_display));
    CU_ASSERT_PTR_NOT_NULL_FATAL(display);
    display->client = client;
    guac_rwlock_init(&display->last_frame.lock);
    guac_flag_init(&display->render_state);
    guac_flag_set(&display->render_state, GUAC_DISPLAY_RENDER_STATE_FRAME_NOT_IN_PROGRESS);

    uint32_t committed[] = { 0, 0x80800000U };
    uint32_t pending[] = { 0xFF0000FFU, 0xFF0000FFU };
    guac_layer previous = { .index = -1 };
    guac_display_layer layer = {
        .layer = GUAC_DEFAULT_LAYER,
        .last_frame_buffer = &previous,
        .last_frame = {
            .width = 2, .height = 1,
            .buffer = (unsigned char*) committed,
            .buffer_stride = sizeof(committed)
        },
        .pending_frame = {
            .width = 1, .height = 2,
            .buffer = (unsigned char*) pending,
            .buffer_stride = sizeof(uint32_t)
        }
    };
    guac_display_layer cursor = { 0 };
    display->last_frame.layers = &layer;
    display->last_frame.frames = 3;
    display->cursor_buffer = &cursor;

    refresh_sink first = { 0 };
    refresh_sink second = { 0 };
    guac_socket* first_socket = refresh_socket(&first);
    guac_socket* second_socket = refresh_socket(&second);
    CU_ASSERT_PTR_NOT_NULL_FATAL(first_socket);
    CU_ASSERT_PTR_NOT_NULL_FATAL(second_socket);
    guac_user first_user = { .client = client, .socket = first_socket };
    guac_user second_user = { .client = client, .socket = second_socket };
    first_user.__next = &second_user;
    second_user.__prev = &first_user;
    client->__users = &first_user;

    CU_ASSERT_EQUAL(guac_display_refresh(display, first_socket), 1);
    CU_ASSERT_EQUAL(second.length, 0);
    verify_refresh_snapshot(&first, GUAC_COMP_SRC);

    /* Initial joining behavior remains unchanged. */
    first.length = 0;
    guac_display_dup(display, first_socket);
    CU_ASSERT_EQUAL(second.length, 0);
    verify_refresh_snapshot(&first, GUAC_COMP_OVER);

    client->__users = NULL;
    guac_socket_free(first_socket);
    guac_socket_free(second_socket);
    guac_flag_destroy(&display->render_state);
    guac_rwlock_destroy(&display->last_frame.lock);
    guac_mem_free(display);
    guac_client_free(client);
}
