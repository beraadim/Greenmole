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

#include "guacamole/display-types.h"

/** Administrative environment override, applied separately to each session. */
#define GUAC_DISPLAY_WORKER_THREADS_ENV "GUAC_DISPLAY_WORKER_THREADS"

/** Bounds per-session thread stacks and allocations, including automatic mode. */
#define GUAC_DISPLAY_MAX_WORKER_THREADS 64

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

#endif
