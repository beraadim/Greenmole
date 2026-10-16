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

/* Run the same deterministic source-injection fixture against the portable
 * backend even when configure selects compiler TLS for the real library.
 * Only these test-local copies are renamed; production symbols are untouched. */
#undef GUAC_THREAD_LOCAL
#define diagnostics_test_init diagnostics_pthread_init
#define diagnostics_test_now diagnostics_pthread_now
#define diagnostics_test_elapsed diagnostics_pthread_elapsed
#define diagnostics_test_set_current diagnostics_pthread_set_current
#define diagnostics_test_current diagnostics_pthread_current
#define diagnostics_test_send_blob diagnostics_pthread_send_blob
#define diagnostics_test_fail diagnostics_pthread_fail
#define diagnostics_test_record_image diagnostics_pthread_record_image
#define diagnostics_test_finish_frame diagnostics_pthread_finish_frame
#define diagnostics_test_get_statistics diagnostics_pthread_get_statistics
#define test_display__diagnostics_default_off pthread_backend_test_display__diagnostics_default_off
#define test_display__diagnostics_numeric_snapshot pthread_backend_test_display__diagnostics_numeric_snapshot
#define test_display__diagnostics_clock_failure pthread_backend_test_display__diagnostics_clock_failure
#define test_display__diagnostics_tls_isolation_and_failures pthread_backend_test_display__diagnostics_tls_isolation_and_failures
#define test_display__diagnostics_blob_accounting pthread_backend_test_display__diagnostics_blob_accounting
#define test_display__diagnostics_log_rate_limit pthread_backend_test_display__diagnostics_log_rate_limit

#include "diagnostics.c"

#undef test_display__diagnostics_default_off
#undef test_display__diagnostics_numeric_snapshot
#undef test_display__diagnostics_clock_failure
#undef test_display__diagnostics_tls_isolation_and_failures
#undef test_display__diagnostics_blob_accounting
#undef test_display__diagnostics_log_rate_limit
#undef diagnostics_test_init
#undef diagnostics_test_now
#undef diagnostics_test_elapsed
#undef diagnostics_test_set_current
#undef diagnostics_test_current
#undef diagnostics_test_send_blob
#undef diagnostics_test_fail
#undef diagnostics_test_record_image
#undef diagnostics_test_finish_frame
#undef diagnostics_test_get_statistics

void test_display__diagnostics_pthread_default_off() {
    pthread_backend_test_display__diagnostics_default_off();
}

void test_display__diagnostics_pthread_numeric_snapshot() {
    pthread_backend_test_display__diagnostics_numeric_snapshot();
}

void test_display__diagnostics_pthread_clock_failure() {
    pthread_backend_test_display__diagnostics_clock_failure();
}

void test_display__diagnostics_pthread_tls_isolation_and_failures() {
    pthread_backend_test_display__diagnostics_tls_isolation_and_failures();
}

void test_display__diagnostics_pthread_blob_accounting() {
    pthread_backend_test_display__diagnostics_blob_accounting();
}

void test_display__diagnostics_pthread_log_rate_limit() {
    pthread_backend_test_display__diagnostics_log_rate_limit();
}
