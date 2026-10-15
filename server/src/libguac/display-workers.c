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

#include "display-priv.h"
#include "display-workers.h"
#include "guacamole/client.h"
#include "guacamole/display.h"
#include "guacamole/mem.h"
#include "guacamole/protocol-types.h"

#ifdef __MINGW32__
#include <winbase.h>
#endif

#include <pthread.h>
#include <sched.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/** Returns the affinity-aware processor count, or zero if unavailable. */
static unsigned long guac_display_nproc(void) {

#if defined(HAVE_SCHED_GETAFFINITY)
    cpu_set_t cpu_set;
    CPU_ZERO(&cpu_set);
    if (sched_getaffinity(0, sizeof(cpu_set), &cpu_set) == 0) {
        int cpu_count = CPU_COUNT(&cpu_set);
        if (cpu_count > 0)
            return cpu_count;
    }
#endif

#if defined(_SC_NPROCESSORS_ONLN)
    long cpu_count = sysconf(_SC_NPROCESSORS_ONLN);
    if (cpu_count > 0)
        return cpu_count;
#elif defined(__MINGW32__)
    DWORD_PTR process_mask, system_mask;
    if (GetProcessAffinityMask(GetCurrentProcess(), &process_mask, &system_mask)) {
        unsigned long cpu_count = 0;
        for (; process_mask != 0; process_mask >>= 1) {
            if (process_mask & 1)
                cpu_count++;
        }
        return cpu_count;
    }
#endif

    return 0;

}

int guac_display_select_worker_count(unsigned long cpu_count,
        const char* override, int* invalid) {

    int automatic = cpu_count == 0 ? 1
        : cpu_count > GUAC_DISPLAY_MAX_WORKER_THREADS
        ? GUAC_DISPLAY_MAX_WORKER_THREADS : (int) cpu_count;
    *invalid = 0;

    if (override == NULL || *override == '\0' || strcmp(override, "auto") == 0)
        return automatic;

    unsigned int count = 0;
    for (const char* digit = override; *digit != '\0'; digit++) {
        if (*digit < '0' || *digit > '9') {
            *invalid = 1;
            return automatic;
        }

        /* The previous value is at most 64, so multiplying cannot overflow.
         * Arbitrarily many leading zeros do not allocate input storage. */
        count = count * 10 + (*digit - '0');
        if (count > GUAC_DISPLAY_MAX_WORKER_THREADS) {
            *invalid = 1;
            return automatic;
        }
    }

    if (count == 0) {
        *invalid = 1;
        return automatic;
    }

    return (int) count;

}

void guac_display_start_workers(guac_display* display) {

    guac_client* client = display->client;
    unsigned long cpu_count = guac_display_nproc();
    if (cpu_count == 0)
        guac_client_log(client, GUAC_LOG_WARNING, "Number of available "
                "processors could not be determined. Assuming single-processor.");
    else
        guac_client_log(client, GUAC_LOG_INFO, "Local system reports %lu "
                "processor(s) are available.", cpu_count);

    int invalid;
    int requested = guac_display_select_worker_count(cpu_count,
            getenv(GUAC_DISPLAY_WORKER_THREADS_ENV), &invalid);
    if (invalid)
        guac_client_log(client, GUAC_LOG_WARNING, "Invalid "
                GUAC_DISPLAY_WORKER_THREADS_ENV "; using automatic worker count "
                "(expected auto or an integer from 1 through %i).",
                GUAC_DISPLAY_MAX_WORKER_THREADS);

    /* requested is bounded, and guac_mem_alloc() additionally checks the
     * allocation multiplication. No worker may start without valid storage. */
    display->worker_threads = guac_mem_alloc(requested, sizeof(pthread_t));
    display->worker_thread_count = 0;
    if (display->worker_threads == NULL) {
        guac_display_stop(display);
        guac_client_abort(client, GUAC_PROTOCOL_STATUS_SERVER_ERROR,
                "Unable to allocate graphical encoding worker pool.");
        return;
    }

    for (int i = 0; i < requested; i++) {
        int result = pthread_create(&display->worker_threads[i], NULL,
                guac_display_worker_thread, display);
        if (result != 0) {
            guac_client_log(client, GUAC_LOG_WARNING, "Unable to create "
                    "graphical encoding worker: %s. Created %i of %i workers.",
                    strerror(result), display->worker_thread_count, requested);
            break;
        }
        display->worker_thread_count++;
    }

    if (display->worker_thread_count == 0) {
        /* Invalidating the FIFO prevents later producers from waiting for a
         * pool which cannot drain it. stop() also sets the stopped flag, so
         * later cleanup cannot wait forever or join an uninitialized handle. */
        guac_display_stop(display);
        guac_client_abort(client, GUAC_PROTOCOL_STATUS_SERVER_ERROR,
                "No graphical encoding worker could be created.");
        return;
    }

    guac_client_log(client, GUAC_LOG_INFO, "Graphical updates will be encoded "
            "using %i worker thread(s) (requested %i, limit %i).",
            display->worker_thread_count, requested,
            GUAC_DISPLAY_MAX_WORKER_THREADS);

}
