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
#include "guacamole/mem.h"

#include <CUnit/CUnit.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <openssl/err.h>
#include <openssl/ssl.h>

static int ssl_failure_test_write(SSL* ssl, const void* buffer, int count);
static int ssl_failure_test_get_error(const SSL* ssl, int result);
static void ssl_failure_test_clear_error(void);
static int ssl_failure_test_shutdown(SSL* ssl);
static void ssl_failure_test_free(SSL* ssl);
static guac_socket* ssl_failure_test_socket_alloc(void);
static void* ssl_failure_test_alloc(size_t count, const size_t* factors);
static int ssl_failure_test_pending(const SSL* ssl);
static int ssl_failure_test_read(SSL* ssl, void* buffer, int count);
static ssize_t ssl_failure_test_recv(int fd, void* buffer, size_t count,
        int flags);
static int ssl_failure_test_shutdown_fd(int fd, int how);

/* Inject only OpenSSL boundaries; use the actual secure socket handler and
 * lock/error lifecycle, including the generic partial-write loop. */
#define SSL_write ssl_failure_test_write
#define SSL_get_error ssl_failure_test_get_error
#define ERR_clear_error ssl_failure_test_clear_error
#define SSL_shutdown ssl_failure_test_shutdown
#define SSL_free ssl_failure_test_free
#define guac_socket_alloc ssl_failure_test_socket_alloc
#define PRIV_guac_mem_alloc ssl_failure_test_alloc
#define SSL_pending ssl_failure_test_pending
#define SSL_read ssl_failure_test_read
#define recv ssl_failure_test_recv
#define shutdown ssl_failure_test_shutdown_fd
#define guac_socket_open_secure ssl_failure_test_open
#include "../../socket-ssl.c"
#undef SSL_write
#undef SSL_get_error
#undef ERR_clear_error
#undef SSL_shutdown
#undef SSL_free
#undef guac_socket_alloc
#undef PRIV_guac_mem_alloc
#undef SSL_pending
#undef SSL_read
#undef recv
#undef shutdown
#undef guac_socket_open_secure

static struct {
    guac_socket_ssl_data* data;
    int results[8];
    int errors[8];
    int system_errors[8];
    int result_count;
    int calls;
    int error_calls;
    int clear_calls;
    int shutdown_calls;
    int free_calls;
    int fail_allocation;
    int pending_calls;
    int read_calls;
    int peek_calls;
    int fd_shutdown_calls;
    int fail_during_peek;
    int peek_result;
    int stage;
    int last_length;
    char output[32];
    size_t length;
} ssl_failure_test;

static void ssl_failure_test_assert_locked(void) {
    int result = pthread_mutex_trylock(&ssl_failure_test.data->ssl_lock);
    CU_ASSERT_EQUAL(result, EBUSY);
    if (result == 0)
        pthread_mutex_unlock(&ssl_failure_test.data->ssl_lock);
}

static void ssl_failure_test_clear_error(void) {
    ssl_failure_test_assert_locked();
    ssl_failure_test.clear_calls++;
    ssl_failure_test.stage = 1;
}

static int ssl_failure_test_write(SSL* ssl, const void* buffer, int count) {
    CU_ASSERT_PTR_EQUAL(ssl, ssl_failure_test.data->ssl);
    CU_ASSERT_EQUAL(ssl_failure_test.stage, 1);
    CU_ASSERT_EQUAL(errno, 0);
    ssl_failure_test_assert_locked();
    ssl_failure_test.stage = 2;
    ssl_failure_test.last_length = count;
    int call = ssl_failure_test.calls++;
    if (call >= ssl_failure_test.result_count) {
        CU_FAIL("Unexpected retry after secure socket write failure");
        return -1;
    }
    int result = ssl_failure_test.results[call];
    errno = ssl_failure_test.system_errors[call];
    if (result > 0 && result <= count) {
        CU_ASSERT_FATAL(ssl_failure_test.length + result <= sizeof(ssl_failure_test.output));
        memcpy(ssl_failure_test.output + ssl_failure_test.length, buffer, result);
        ssl_failure_test.length += result;
    }
    return result;
}

static int ssl_failure_test_get_error(const SSL* ssl, int result) {
    CU_ASSERT_PTR_EQUAL(ssl, ssl_failure_test.data->ssl);
    CU_ASSERT_EQUAL(ssl_failure_test.stage, 2);
    CU_ASSERT_EQUAL(result, ssl_failure_test.results[ssl_failure_test.calls - 1]);
    ssl_failure_test_assert_locked();
    ssl_failure_test.stage = 3;
    ssl_failure_test.error_calls++;
    /* Ensure the handler preserves the syscall errno across classification. */
    errno = EDOM;
    return ssl_failure_test.errors[ssl_failure_test.calls - 1];
}

static int ssl_failure_test_shutdown(SSL* ssl) {
    CU_ASSERT_PTR_EQUAL(ssl, ssl_failure_test.data->ssl);
    ssl_failure_test.shutdown_calls++;
    return 1;
}

static void ssl_failure_test_free(SSL* ssl) {
    if (ssl_failure_test.fail_allocation) {
        ssl_failure_test.free_calls++;
        SSL_free(ssl);
        return;
    }
    CU_ASSERT_PTR_EQUAL(ssl, ssl_failure_test.data->ssl);
    ssl_failure_test.free_calls++;
}

static guac_socket* ssl_failure_test_socket_alloc(void) {
    if (ssl_failure_test.fail_allocation == 1) {
        guac_error = GUAC_STATUS_NO_MEMORY;
        return NULL;
    }
    return guac_socket_alloc();
}

static void* ssl_failure_test_alloc(size_t count, const size_t* factors) {
    if (ssl_failure_test.fail_allocation == 2) {
        guac_error = GUAC_STATUS_NO_MEMORY;
        return NULL;
    }
    return PRIV_guac_mem_alloc(count, factors);
}

static int ssl_failure_test_pending(const SSL* ssl) {
    CU_ASSERT_PTR_EQUAL(ssl, ssl_failure_test.data->ssl);
    ssl_failure_test.pending_calls++;
    return 0;
}

static int ssl_failure_test_read(SSL* ssl, void* buffer, int count) {
    (void) ssl;
    (void) buffer;
    (void) count;
    ssl_failure_test.read_calls++;
    CU_FAIL("Further TLS I/O after a terminal write failure");
    return -1;
}

static ssize_t ssl_failure_test_recv(int fd, void* buffer, size_t count,
        int flags) {
    (void) fd;
    (void) buffer;
    CU_ASSERT_EQUAL(count, 1);
    CU_ASSERT_EQUAL(flags, MSG_PEEK);
    ssl_failure_test.peek_calls++;
    if (ssl_failure_test.fail_during_peek) {
        /* Model the writer acquiring ssl_lock after the reader's readiness
         * check but before its final locked SSL_read(). */
        guac_socket socket = {.data = ssl_failure_test.data};
        CU_ASSERT_EQUAL(__guac_socket_ssl_write_handler(&socket, "test", 4), -1);
    }
    errno = EBADF;
    return ssl_failure_test.peek_result;
}

static int ssl_failure_test_shutdown_fd(int fd, int how) {
    CU_ASSERT_EQUAL(fd, ssl_failure_test.data->fd);
    CU_ASSERT_EQUAL(how, SHUT_RDWR);
    ssl_failure_test.fd_shutdown_calls++;
    return 0;
}

static void ssl_failure_test_init(guac_socket* socket,
        guac_socket_ssl_data* data) {
    memset(&ssl_failure_test, 0, sizeof(ssl_failure_test));
    memset(socket, 0, sizeof(*socket));
    memset(data, 0, sizeof(*data));
    data->fd = -1;
    data->ssl = (SSL*) data;
    CU_ASSERT_EQUAL_FATAL(pthread_mutex_init(&data->ssl_lock, NULL), 0);
    CU_ASSERT_EQUAL_FATAL(pthread_mutex_init(&data->socket_lock, NULL), 0);
    socket->data = data;
    socket->write_handler = __guac_socket_ssl_write_handler;
    ssl_failure_test.data = data;
}

static void ssl_failure_test_destroy(guac_socket_ssl_data* data) {
    pthread_mutex_destroy(&data->socket_lock);
    pthread_mutex_destroy(&data->ssl_lock);
}

void test_socket__ssl_partial_writes_preserve_bytes_and_bound_length(void) {
    guac_socket socket;
    guac_socket_ssl_data data;
    ssl_failure_test_init(&socket, &data);
    ssl_failure_test.results[0] = 2;
    ssl_failure_test.results[1] = 4;
    ssl_failure_test.result_count = 2;
    CU_ASSERT_EQUAL(guac_socket_write(&socket, "abcdef", 6), 0);
    CU_ASSERT_EQUAL(ssl_failure_test.calls, 2);
    CU_ASSERT_EQUAL(ssl_failure_test.clear_calls, 2);
    CU_ASSERT_EQUAL(ssl_failure_test.error_calls, 0);
    CU_ASSERT_EQUAL(ssl_failure_test.length, 6);
    CU_ASSERT_NSTRING_EQUAL(ssl_failure_test.output, "abcdef", 6);
    CU_ASSERT_EQUAL(__guac_socket_ssl_write_handler(&socket, NULL, 0), 0);
    CU_ASSERT_EQUAL(ssl_failure_test.calls, 2);
    ssl_failure_test_destroy(&data);

    ssl_failure_test_init(&socket, &data);
    ssl_failure_test.results[0] = 1;
    ssl_failure_test.result_count = 1;
    CU_ASSERT_EQUAL(__guac_socket_ssl_write_handler(&socket, "x",
                (size_t) INT_MAX + 1), 1);
    CU_ASSERT_EQUAL(ssl_failure_test.last_length, INT_MAX);
    ssl_failure_test_destroy(&data);
}

void test_socket__ssl_zero_retry_and_fatal_results_fail_closed(void) {
    const struct {
        int result;
        int ssl_error;
        int system_error;
        guac_status expected;
    } cases[] = {
        {0, SSL_ERROR_ZERO_RETURN, 0, GUAC_STATUS_CLOSED},
        {0, SSL_ERROR_SYSCALL, 0, GUAC_STATUS_IO_ERROR},
        {-1, SSL_ERROR_SYSCALL, EPIPE, GUAC_STATUS_SEE_ERRNO},
        {-1, SSL_ERROR_SYSCALL, EINTR, GUAC_STATUS_SEE_ERRNO},
        {-1, SSL_ERROR_SSL, 0, GUAC_STATUS_IO_ERROR},
        {-1, SSL_ERROR_WANT_READ, 0, GUAC_STATUS_IO_ERROR},
        {-1, SSL_ERROR_WANT_WRITE, 0, GUAC_STATUS_IO_ERROR}
    };
    size_t i;
    for (i = 0; i < sizeof(cases) / sizeof(*cases); i++) {
        guac_socket socket;
        guac_socket_ssl_data data;
        ssl_failure_test_init(&socket, &data);
        ssl_failure_test.results[0] = cases[i].result;
        ssl_failure_test.errors[0] = cases[i].ssl_error;
        ssl_failure_test.system_errors[0] = cases[i].system_error;
        ssl_failure_test.result_count = 1;
        errno = EDOM;
        CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "test", 4), 0);
        CU_ASSERT_EQUAL(guac_error, cases[i].expected);
        CU_ASSERT_EQUAL(errno, cases[i].system_error);
        guac_error = GUAC_STATUS_SUCCESS;
        errno = 0;
        CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "later", 5), 0);
        CU_ASSERT_EQUAL(guac_error, cases[i].expected);
        CU_ASSERT_EQUAL(errno, cases[i].system_error);
        CU_ASSERT_EQUAL(ssl_failure_test.calls, 1);
        CU_ASSERT_EQUAL(ssl_failure_test.error_calls, 1);
        CU_ASSERT_EQUAL(ssl_failure_test.clear_calls, 1);
        CU_ASSERT_EQUAL(ssl_failure_test.fd_shutdown_calls, 1);
        ssl_failure_test_destroy(&data);
    }
}

void test_socket__ssl_partial_failure_never_replays_prefix(void) {
    guac_socket socket;
    guac_socket_ssl_data data;
    ssl_failure_test_init(&socket, &data);
    ssl_failure_test.results[0] = 2;
    ssl_failure_test.results[1] = -1;
    ssl_failure_test.errors[1] = SSL_ERROR_SSL;
    ssl_failure_test.result_count = 2;
    CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "abcdef", 6), 0);
    CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "abcdef", 6), 0);
    CU_ASSERT_EQUAL(ssl_failure_test.calls, 2);
    CU_ASSERT_EQUAL(ssl_failure_test.length, 2);
    CU_ASSERT_NSTRING_EQUAL(ssl_failure_test.output, "ab", 2);
    ssl_failure_test_destroy(&data);
}

void test_socket__ssl_failed_write_skips_tls_shutdown(void) {
    int failed;
    for (failed = 0; failed <= 1; failed++) {
        guac_socket socket;
        guac_socket_ssl_data* data = malloc(sizeof(*data));
        CU_ASSERT_PTR_NOT_NULL_FATAL(data);
        ssl_failure_test_init(&socket, data);
        if (failed) {
            ssl_failure_test.results[0] = -1;
            ssl_failure_test.errors[0] = SSL_ERROR_SSL;
            ssl_failure_test.result_count = 1;
            CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "test", 4), 0);
        }
        CU_ASSERT_EQUAL(__guac_socket_ssl_free_handler(&socket), 0);
        CU_ASSERT_EQUAL(ssl_failure_test.shutdown_calls, !failed);
        CU_ASSERT_EQUAL(ssl_failure_test.free_calls, 1);
    }
}

void test_socket__ssl_allocation_failure_releases_connection(void) {
    /* A real SSL object is allocated and released on each fault path, before
     * any descriptor association or handshake can take place. */
    SSL_CTX* context = SSL_CTX_new(SSLv23_server_method());
    CU_ASSERT_PTR_NOT_NULL_FATAL(context);
    int failure;
    for (failure = 1; failure <= 2; failure++) {
        memset(&ssl_failure_test, 0, sizeof(ssl_failure_test));
        ssl_failure_test.fail_allocation = failure;
        CU_ASSERT_PTR_NULL(ssl_failure_test_open(context, -1));
        CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_NO_MEMORY);
        CU_ASSERT_EQUAL(ssl_failure_test.free_calls, 1);
    }
    SSL_CTX_free(context);
}

void test_socket__ssl_write_failure_prevents_later_read_or_wait(void) {
    const int errors[] = {SSL_ERROR_SSL, SSL_ERROR_WANT_WRITE};
    size_t i;
    for (i = 0; i < sizeof(errors) / sizeof(*errors); i++) {
        guac_socket socket;
        guac_socket_ssl_data data;
        ssl_failure_test_init(&socket, &data);
        ssl_failure_test.results[0] = -1;
        ssl_failure_test.errors[0] = errors[i];
        ssl_failure_test.result_count = 1;
        CU_ASSERT_NOT_EQUAL(guac_socket_write(&socket, "test", 4), 0);
        char buffer[4];
        /* A terminal failure is ready to read immediately; select must not
         * wait on the descriptor and read must report it without TLS I/O. */
        CU_ASSERT_EQUAL(__guac_socket_ssl_select_handler(&socket, -1), 1);
        CU_ASSERT_EQUAL(__guac_socket_ssl_read_handler(&socket, buffer, 4), -1);
        CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_IO_ERROR);
        CU_ASSERT_EQUAL(ssl_failure_test.pending_calls, 0);
        CU_ASSERT_EQUAL(ssl_failure_test.peek_calls, 0);
        CU_ASSERT_EQUAL(ssl_failure_test.read_calls, 0);
        CU_ASSERT_EQUAL(ssl_failure_test.fd_shutdown_calls, 1);
        ssl_failure_test_destroy(&data);
    }
}

void test_socket__ssl_write_failure_during_read_wait_prevents_tls_read(void) {
    int peek_result;
    for (peek_result = -1; peek_result <= 1; peek_result++) {
        guac_socket socket;
        guac_socket_ssl_data data;
        ssl_failure_test_init(&socket, &data);
        ssl_failure_test.results[0] = -1;
        ssl_failure_test.errors[0] = SSL_ERROR_SSL;
        ssl_failure_test.result_count = 1;
        ssl_failure_test.fail_during_peek = 1;
        ssl_failure_test.peek_result = peek_result;
        char buffer[4];
        CU_ASSERT_EQUAL(__guac_socket_ssl_read_handler(&socket, buffer, 4), -1);
        CU_ASSERT_EQUAL(guac_error, GUAC_STATUS_IO_ERROR);
        CU_ASSERT_EQUAL(errno, 0);
        CU_ASSERT_EQUAL(ssl_failure_test.pending_calls, 1);
        CU_ASSERT_EQUAL(ssl_failure_test.peek_calls, 1);
        CU_ASSERT_EQUAL(ssl_failure_test.read_calls, 0);
        CU_ASSERT_EQUAL(ssl_failure_test.fd_shutdown_calls, 1);
        ssl_failure_test_destroy(&data);
    }
}
