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

#include "guacamole/socket.h"

#include <CUnit/CUnit.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

static ssize_t fd_failure_test_write(int fd, const void* buffer, size_t count);

/* Only the syscall boundary is replaced. The real buffering, EINTR loop,
 * failure latch and public socket writer are exercised together. */
#define write fd_failure_test_write
#define guac_socket_open fd_failure_test_open
#define guac_socket_fd_write fd_failure_test_direct_write
#include "../../socket-fd.c"
#undef write
#undef guac_socket_open
#undef guac_socket_fd_write

static struct {
    ssize_t results[8];
    int errors[8];
    int result_count;
    int calls;
    char output[32];
    size_t length;
} fd_failure_test;

static ssize_t fd_failure_test_write(int fd, const void* buffer, size_t count) {
    (void) fd;
    int call = fd_failure_test.calls++;
    if (call >= fd_failure_test.result_count) {
        CU_FAIL("Unexpected retry after terminal socket write failure");
        errno = EIO;
        return -1;
    }
    ssize_t result = fd_failure_test.results[call];
    errno = fd_failure_test.errors[call];
    if (result > 0 && (size_t) result <= count) {
        CU_ASSERT_FATAL(fd_failure_test.length + result <= sizeof(fd_failure_test.output));
        memcpy(fd_failure_test.output + fd_failure_test.length, buffer, result);
        fd_failure_test.length += result;
    }
    return result;
}

static void fd_failure_test_init(guac_socket* socket, guac_socket_fd_data* data) {
    memset(&fd_failure_test, 0, sizeof(fd_failure_test));
    memset(socket, 0, sizeof(*socket));
    memset(data, 0, sizeof(*data));
    CU_ASSERT_EQUAL_FATAL(pthread_mutex_init(&data->buffer_lock, NULL), 0);
    socket->data = data;
    socket->write_handler = guac_socket_fd_write_handler;
    socket->flush_handler = guac_socket_fd_flush_handler;
}

void test_socket__fd_retries_eintr_and_preserves_partial_write_bytes(void) {
    guac_socket socket;
    guac_socket_fd_data data;
    fd_failure_test_init(&socket, &data);
    fd_failure_test.results[0] = -1;
    fd_failure_test.errors[0] = EINTR;
    fd_failure_test.results[1] = 2;
    fd_failure_test.results[2] = -1;
    fd_failure_test.errors[2] = EINTR;
    fd_failure_test.results[3] = 4;
    fd_failure_test.result_count = 4;
    CU_ASSERT_EQUAL(guac_socket_write(&socket, "abcdef", 6), 0);
    CU_ASSERT_EQUAL(guac_socket_flush(&socket), 0);
    CU_ASSERT_EQUAL(fd_failure_test.calls, 4);
    CU_ASSERT_EQUAL(fd_failure_test.length, 6);
    CU_ASSERT_NSTRING_EQUAL(fd_failure_test.output, "abcdef", 6);
    CU_ASSERT_EQUAL(data.failed_errno, 0);
    pthread_mutex_destroy(&data.buffer_lock);
}

void test_socket__fd_zero_progress_is_terminal_and_not_replayed(void) {
    guac_socket socket;
    guac_socket_fd_data data;
    fd_failure_test_init(&socket, &data);
    fd_failure_test.results[0] = 0;
    fd_failure_test.result_count = 1;
    CU_ASSERT_EQUAL(guac_socket_write(&socket, "test", 4), 0);
    CU_ASSERT_NOT_EQUAL(guac_socket_flush(&socket), 0);
    CU_ASSERT_EQUAL(data.failed_errno, EIO);
    CU_ASSERT_EQUAL(data.written, 0);
    CU_ASSERT_NOT_EQUAL(guac_socket_flush(&socket), 0);
    CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "later", 5), 0);
    CU_ASSERT_EQUAL(fd_failure_test_direct_write(&socket, "test", 4), -1);
    CU_ASSERT_EQUAL(fd_failure_test.calls, 1);
    pthread_mutex_destroy(&data.buffer_lock);
}

void test_socket__fd_partial_terminal_errors_preserve_first_failure(void) {
    const int errors[] = {EPIPE, EAGAIN, 0};
    size_t i;
    for (i = 0; i < sizeof(errors) / sizeof(*errors); i++) {
        guac_socket socket;
        guac_socket_fd_data data;
        fd_failure_test_init(&socket, &data);
        fd_failure_test.results[0] = 2;
        fd_failure_test.results[1] = -1;
        fd_failure_test.errors[1] = errors[i];
        fd_failure_test.result_count = 2;
        CU_ASSERT_EQUAL(guac_socket_write(&socket, "test", 4), 0);
        CU_ASSERT_NOT_EQUAL(guac_socket_flush(&socket), 0);
        CU_ASSERT_EQUAL(data.written, 0);
        CU_ASSERT_EQUAL(data.failed_errno, errors[i] ? errors[i] : EIO);
        errno = 0;
        CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "later", 5), 0);
        CU_ASSERT_EQUAL(errno, data.failed_errno);
        CU_ASSERT_NOT_EQUAL(guac_socket_flush(&socket), 0);
        CU_ASSERT_EQUAL(fd_failure_test_direct_write(&socket, "test", 4), -1);
        CU_ASSERT_EQUAL(fd_failure_test.calls, 2);
        CU_ASSERT_EQUAL(fd_failure_test.length, 2);
        CU_ASSERT_NSTRING_EQUAL(fd_failure_test.output, "te", 2);
        pthread_mutex_destroy(&data.buffer_lock);
    }
}

void test_socket__fd_full_buffer_failure_stops_additional_input(void) {
    guac_socket socket;
    guac_socket_fd_data data;
    fd_failure_test_init(&socket, &data);
    fd_failure_test.results[0] = 2;
    fd_failure_test.results[1] = 0;
    fd_failure_test.result_count = 2;
    char input[GUAC_SOCKET_OUTPUT_BUFFER_SIZE + 1];
    memset(input, 'x', sizeof(input));
    CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, input, sizeof(input)), 0);
    CU_ASSERT_EQUAL(data.written, 0);
    CU_ASSERT_EQUAL(fd_failure_test.calls, 2);
    CU_ASSERT_EQUAL(fd_failure_test.length, 2);
    CU_ASSERT_NOT_EQUAL(guac_socket_flush(&socket), 0);
    CU_ASSERT_EQUAL(fd_failure_test.calls, 2);
    pthread_mutex_destroy(&data.buffer_lock);
}
