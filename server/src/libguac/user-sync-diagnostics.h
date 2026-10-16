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

#ifndef GUAC_USER_SYNC_DIAGNOSTICS_H
#define GUAC_USER_SYNC_DIAGNOSTICS_H

#include "guacamole/user.h"

/* Private, optional per-user aggregate; no wire extension or retained samples. */
void guac_user_sync_diagnostics_init(guac_user* user);
void guac_user_sync_diagnostics_free(guac_user* user);
void guac_user_sync_diagnostics_record(guac_user* user, guac_timestamp now,
        guac_timestamp timestamp, guac_timestamp previous);

/* Saturates existing integer lag fields without changing fresh ACK behavior. */
int guac_user_sync_elapsed(guac_timestamp now, guac_timestamp timestamp);

/* Strict nonnegative timestamp parsing avoids overflow and malformed sync ACKs. */
int guac_user_sync_parse_timestamp(const char* value, guac_timestamp* timestamp);

#endif
