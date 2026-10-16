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

#include "guacamole/error.h"
#include "guacamole/protocol.h"
#include "guacamole/socket.h"
#include "guacamole/stream.h"

#include <CUnit/CUnit.h>
#include <limits.h>
#include <string.h>

typedef struct socket_write_test_data {
    char output[4096];
    size_t length;
    ssize_t results[16];
    int result_count;
    int calls;
    int locked;
    int unlocks;
    int fail_base64;
} socket_write_test_data;

static ssize_t socket_write_test_handler(guac_socket* socket,
        const void* buffer, size_t count) {
    socket_write_test_data* data = socket->data;
    int call = data->calls++;
    ssize_t result = count;

    /* Fault scripts are bounded even if a broken implementation retries zero
     * progress. This turns the old spin into a deterministic failed assertion. */
    if (data->result_count)
        result = call < data->result_count ? data->results[call] : -1;
    if (data->fail_base64 && count == 4)
        result = -1;

    if (result < 0) {
        guac_error = GUAC_STATUS_IO_ERROR;
        guac_error_message = "Injected socket write failure";
    }
    else if ((size_t) result <= count) {
        CU_ASSERT_FATAL(data->length + result <= sizeof(data->output));
        memcpy(data->output + data->length, buffer, result);
        data->length += result;
    }
    return result;
}

static void socket_write_test_lock(guac_socket* socket) {
    socket_write_test_data* data = socket->data;
    CU_ASSERT_EQUAL(data->locked, 0);
    data->locked = 1;
}

static void socket_write_test_unlock(guac_socket* socket) {
    socket_write_test_data* data = socket->data;
    CU_ASSERT_EQUAL(data->locked, 1);
    data->locked = 0;
    data->unlocks++;
}

static void socket_write_test_init(guac_socket* socket,
        socket_write_test_data* data) {
    memset(socket, 0, sizeof(*socket));
    memset(data, 0, sizeof(*data));
    socket->data = data;
    socket->write_handler = socket_write_test_handler;
    socket->lock_handler = socket_write_test_lock;
    socket->unlock_handler = socket_write_test_unlock;
}

void test_socket__write_partial_progress_preserves_bytes(void) {
    guac_socket socket;
    socket_write_test_data data;
    socket_write_test_init(&socket, &data);
    data.results[0] = 2;
    data.results[1] = 1;
    data.results[2] = 3;
    data.result_count = 3;
    CU_ASSERT_EQUAL(guac_socket_write(&socket, "abcdef", 6), 0);
    CU_ASSERT_EQUAL(data.calls, 3);
    CU_ASSERT_EQUAL(data.length, 6);
    CU_ASSERT_NSTRING_EQUAL(data.output, "abcdef", 6);
    CU_ASSERT_EQUAL(guac_socket_write(&socket, NULL, 0), 0);
    CU_ASSERT_EQUAL(data.calls, 3);
}

void test_socket__write_rejects_zero_negative_and_excessive_counts(void) {
    const ssize_t invalid[] = {0, -2, 5,
        (ssize_t) ((size_t) INT_MAX + 1)};
    size_t i;
    for (i = 0; i < sizeof(invalid) / sizeof(*invalid); i++) {
        guac_socket socket;
        socket_write_test_data data;
        socket_write_test_init(&socket, &data);
        data.results[0] = invalid[i];
        data.result_count = 1;
        CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "test", 4), 0);
        CU_ASSERT_EQUAL(data.calls, 1);
        CU_ASSERT_EQUAL(data.length, 0);
        CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_IO_ERROR);
    }
}

void test_socket__write_does_not_retry_a_partial_failure(void) {
    guac_socket socket;
    socket_write_test_data data;
    socket_write_test_init(&socket, &data);
    data.results[0] = 2;
    data.results[1] = -1;
    data.result_count = 2;
    CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "abcdef", 6), 0);
    CU_ASSERT_EQUAL(data.calls, 2);
    CU_ASSERT_EQUAL(data.length, 2);
    CU_ASSERT_NSTRING_EQUAL(data.output, "ab", 2);
}

void test_socket__base64_wire_vectors_and_buffer_boundaries(void) {
    const char* expected[] = {"", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==",
        "Zm9vYmE=", "Zm9vYmFy"};
    size_t i;
    for (i = 0; i < sizeof(expected) / sizeof(*expected); i++) {
        guac_socket socket;
        socket_write_test_data data;
        socket_write_test_init(&socket, &data);
        CU_ASSERT_EQUAL(guac_socket_write_base64(&socket, "foobar", i), 0);
        CU_ASSERT_EQUAL(guac_socket_flush_base64(&socket), 0);
        CU_ASSERT_EQUAL(data.length, strlen(expected[i]));
        CU_ASSERT_NSTRING_EQUAL(data.output, expected[i], data.length);
    }

    /* Two automatic flushes plus a padded final byte, split across calls. */
    unsigned char zeros[1537] = {0};
    guac_socket socket;
    socket_write_test_data data;
    socket_write_test_init(&socket, &data);
    CU_ASSERT_EQUAL(guac_socket_write_base64(&socket, zeros, 767), 0);
    CU_ASSERT_EQUAL(guac_socket_write_base64(&socket, zeros + 767, 770), 0);
    CU_ASSERT_EQUAL(guac_socket_flush_base64(&socket), 0);
    CU_ASSERT_EQUAL(data.length, 2052);
    for (i = 0; i < 2050; i++)
        CU_ASSERT_EQUAL(data.output[i], 'A');
    CU_ASSERT_NSTRING_EQUAL(data.output + 2050, "==", 2);
}

void test_socket__base64_propagates_positive_failure_without_replay(void) {
    guac_socket socket;
    socket_write_test_data data;
    socket_write_test_init(&socket, &data);
    data.results[0] = 2;
    data.results[1] = -1;
    data.result_count = 2;
    CU_ASSERT_EQUAL(guac_socket_write_base64(&socket, "foo", 3), 0);
    CU_ASSERT_EQUAL(guac_socket_flush_base64(&socket), 1);
    CU_ASSERT_EQUAL(socket.__ready, 0);
    CU_ASSERT_EQUAL(data.length, 2);
    CU_ASSERT_NSTRING_EQUAL(data.output, "Zm", 2);
    CU_ASSERT_EQUAL(guac_socket_flush_base64(&socket), 0);
    CU_ASSERT_EQUAL(data.calls, 2);

    unsigned char zeros[769] = {0};
    socket_write_test_init(&socket, &data);
    data.results[0] = -1;
    data.result_count = 1;
    CU_ASSERT_EQUAL(guac_socket_write_base64(&socket, zeros, sizeof(zeros)), 1);
    CU_ASSERT_EQUAL(socket.__ready, 0);
    CU_ASSERT_EQUAL(data.calls, 1);
}

void test_socket__blob_failure_stops_instruction_and_releases_lock(void) {
    guac_socket socket;
    socket_write_test_data data;
    socket_write_test_init(&socket, &data);
    guac_stream stream = {.index = 7};
    data.fail_base64 = 1;
    CU_ASSERT_NOT_EQUAL(guac_protocol_send_blob(&socket, &stream, "foo", 3), 0);
    CU_ASSERT_EQUAL(data.locked, 0);
    CU_ASSERT_EQUAL(data.unlocks, 1);
    CU_ASSERT_EQUAL(data.length, strlen("4.blob,1.7,4."));
    CU_ASSERT_NSTRING_EQUAL(data.output, "4.blob,1.7,4.", data.length);

    socket_write_test_init(&socket, &data);
    CU_ASSERT_EQUAL(guac_protocol_send_blob(&socket, &stream, "foo", 3), 0);
    CU_ASSERT_EQUAL(data.unlocks, 1);
    CU_ASSERT_EQUAL(data.length, strlen("4.blob,1.7,4.Zm9v;"));
    CU_ASSERT_NSTRING_EQUAL(data.output, "4.blob,1.7,4.Zm9v;", data.length);
}
