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

#ifndef GUAC_DISPLAY_WORKERS_H
#define GUAC_DISPLAY_WORKERS_H

#include "display-plan.h"
#include "guacamole/display-types.h"

#include <stddef.h>
#include <stdint.h>

/** Administrative environment override, applied separately to each session. */
#define GUAC_DISPLAY_WORKER_THREADS_ENV "GUAC_DISPLAY_WORKER_THREADS"

/** Bounds per-session thread stacks and allocations, including automatic mode. */
#define GUAC_DISPLAY_MAX_WORKER_THREADS 64

/** Reviewed partial-batch ceiling, independent of the allocated pool size. */
#define GUAC_DISPLAY_PARTIAL_BATCH_WORKERS 12

/**
 * Selects a bounded worker count. NULL, empty, and "auto" retain automatic
 * selection. Overrides must contain only decimal digits and be in [1, 64].
 * Invalid overrides set *invalid and fall back to automatic selection. A zero
 * detected CPU count falls back to one worker. No environment value is logged.
 */
int guac_display_select_worker_count(unsigned long cpu_count,
        const char* override, int* invalid);

/**
 * Allocates and starts the configured worker pool. Only successfully created
 * threads are tracked and subsequently joined. A partial pool remains usable;
 * if no worker can be created, the display and client are stopped immediately.
 */
void guac_display_start_workers(guac_display* display);

/** Selects a bounded active count without changing the persistent pool. */
int guac_display_select_active_workers(int pool_size, size_t image_count,
        uint64_t image_pixels, uint64_t desktop_pixels);

/**
 * Selects the limit for the next frame. The operation FIFO must be locked and
 * the preceding frame must have finished before this function is called.
 */
void guac_display_configure_worker_frame(guac_display* display,
        const guac_display_plan* plan);

/**
 * Private benchmark control: 0 keeps full concurrency, 1 selects the default
 * workload policy, and 2..64 select a test ceiling for partial batches. Changes
 * subsequent frames only, never a frame already in progress. No protocol or
 * runtime environment setting exposes this knob.
 */
void guac_display_set_worker_policy(guac_display* display, int workload_aware);

/**
 * Waits for both queued work and capacity, then returns one operation with the
 * FIFO locked. No operation is claimed while waiting for admission. Returns
 * zero with the FIFO unlocked when shutdown invalidates it.
 */
int guac_display_worker_dequeue_and_lock(guac_display* display,
        guac_display_plan_operation* operation);

#endif
