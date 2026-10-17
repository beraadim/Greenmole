/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to you under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with the
 * License. You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


#include "../../display-priv.h"
#include "guacamole/client.h"
#include "guacamole/display.h"
#include "guacamole/timestamp.h"
#include <CUnit/CUnit.h>
#include <pthread.h>

static void* release_busy_worker(void* data) {
    guac_display* display = data;
    guac_timestamp_msleep(30);
    guac_fifo_lock(&display->ops);
    display->active_workers = 0;
    guac_fifo_unlock(&display->ops);
    return NULL;
}

/** An empty FIFO alone cannot establish ordering while an encoder owns work. */
void test_display__video_barrier_waits_for_claimed_image_work() {
    guac_client* client = guac_client_alloc();
    CU_ASSERT_PTR_NOT_NULL_FATAL(client);
    guac_display* display = guac_display_alloc(client);
    guac_fifo_lock(&display->ops);
    display->active_workers = 1;
    guac_fifo_unlock(&display->ops);
    pthread_t worker;
    CU_ASSERT_EQUAL_FATAL(pthread_create(&worker, NULL, release_busy_worker, display), 0);
    guac_timestamp start = guac_timestamp_current();
    CU_ASSERT_TRUE(guac_display_flush_to_idle(display, 250));
    CU_ASSERT_TRUE(guac_timestamp_current() - start >= 20);
    pthread_join(worker, NULL);
    guac_display_free(display);
    guac_client_free(client);
}

/** A persistent image backlog and an invalidated queue both reject video. */
void test_display__video_barrier_rejects_busy_or_stopped_pipeline() {
    guac_client* client = guac_client_alloc();
    CU_ASSERT_PTR_NOT_NULL_FATAL(client);
    guac_display* display = guac_display_alloc(client);
    guac_fifo_lock(&display->ops);
    display->active_workers = 1;
    guac_fifo_unlock(&display->ops);
    CU_ASSERT_FALSE(guac_display_flush_to_idle(display, 10));
    guac_fifo_lock(&display->ops);
    display->active_workers = 0;
    guac_fifo_unlock(&display->ops);
    guac_display_stop(display);
    CU_ASSERT_FALSE(guac_display_flush_to_idle(display, 0));
    guac_display_free(display);
    guac_client_free(client);
}
