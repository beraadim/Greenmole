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

var Guacamole = Guacamole || {};

/**
 * A one-shot timer whose deadline may move without repeatedly allocating a
 * timeout. A later deadline is checked by the existing timeout when it fires;
 * an earlier deadline replaces that timeout. Cancellation rejects callbacks
 * already queued by the browser, including after this timer is reused.
 *
 * @constructor
 * @param {!function():number} clock Clock used by the supplied deadlines.
 * @param {!function()} callback Called once when the latest deadline is due.
 */
Guacamole.DeadlineTimer = function DeadlineTimer(clock, callback) {

    var deadline = null;
    var armedDeadline = null;
    var pending = null;

    function arm() {
        var token = {};
        pending = token;
        armedDeadline = deadline;
        token.id = window.setTimeout(function checkDeadline() {
            if (pending !== token)
                return;

            pending = null;
            if (clock() < deadline)
                arm();
            else {
                deadline = null;
                callback();
            }
        }, Math.min(0x7FFFFFFF, Math.max(0, deadline - clock())));
    }

    /** Schedules a deadline expressed in milliseconds in the supplied clock. */
    this.schedule = function schedule(value) {
        deadline = value;
        if (pending === null)
            arm();
        else if (deadline < armedDeadline) {
            window.clearTimeout(pending.id);
            arm();
        }
    };

    /** Cancels the current deadline and permits later reuse of this timer. */
    this.cancel = function cancel() {
        if (pending !== null)
            window.clearTimeout(pending.id);
        pending = deadline = armedDeadline = null;
    };

};

/**
 * Returns an elapsed-time clock where available. Wall-clock timestamps used
 * in protocol ping payloads remain separate from interval scheduling.
 * @returns {!number} Current elapsed milliseconds.
 */
Guacamole.DeadlineTimer.now = function now() {
    return window.performance && window.performance.now
            ? window.performance.now() : new Date().getTime();
};
