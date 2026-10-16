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
 * Bounded numeric measurements of local sync receipt, rendering backlog and
 * sync ACK attempts. No timer, protocol extension, payload or timestamp history
 * is retained. Construct only when explicitly enabled by the local application.
 * Durations are local elapsed times, never remote timestamp differences.
 *
 * @constructor
 */
Guacamole.PipelineDiagnostics = function PipelineDiagnostics() {
    var generation = {};
    var pending = 0;
    var lastSync = null;
    var limit = 9007199254740991;
    var values = {
        syncReceived: 0, ackAttempted: 0, duplicateSync: 0, canceledSync: 0,
        completedSync: 0, syncToAckSumMs: 0, syncToAckMaxMs: 0,
        syncGapMaxMs: 0, inFlightMax: 0, pendingFramesMax: 0,
        oldestFrameAgeMaxMs: 0, blockedSamples: 0
    };
    function number(value) {
        return typeof value === 'number' && isFinite(value) && value > 0
                ? Math.min(value, limit) : 0;
    }
    function add(name, value) {
        values[name] = Math.min(limit, values[name] + number(value));
    }
    function maximum(name, value) {
        values[name] = Math.max(values[name], number(value));
    }
    function now() {
        return window.performance && typeof window.performance.now === 'function'
                ? window.performance.now() : new Date().getTime();
    }
    function sampleQueue(queue) {
        if (!queue) return;
        maximum('pendingFramesMax', queue.pendingFrames);
        maximum('oldestFrameAgeMaxMs', queue.oldestFrameAge);
        if (queue.blocked === true) add('blockedSamples', 1);
    }
    /** Begins a sync measurement; returned token belongs only to its callback. */
    this.begin = function begin(queue) {
        var current = now();
        add('syncReceived', 1);
        pending = Math.min(limit, pending + 1);
        maximum('inFlightMax', pending);
        if (lastSync !== null) maximum('syncGapMaxMs', current - lastSync);
        lastSync = current;
        sampleQueue(queue);
        return { generation: generation, start: current, complete: false };
    };
    /** Completes immediately before the existing ACK attempt, including audio sync. */
    this.complete = function complete(token, acknowledge, queue) {
        if (!token || token.complete || token.generation !== generation) return;
        token.complete = true;
        pending = Math.max(0, pending - 1);
        add('completedSync', 1);
        if (acknowledge) {
            var elapsed = number(now() - token.start);
            add('ackAttempted', 1);
            add('syncToAckSumMs', elapsed);
            maximum('syncToAckMaxMs', elapsed);
        }
        else add('duplicateSync', 1);
        sampleQueue(queue);
    };
    /** Cancels pending samples when the local connection is replaced or stopped. */
    this.cancel = function cancel() {
        add('canceledSync', pending);
        pending = 0;
        lastSync = null;
        generation = {};
    };
    /** Returns a new numeric-only snapshot; callers cannot mutate retained state. */
    this.getStatistics = function getStatistics() {
        var result = {};
        for (var name in values) result[name] = values[name];
        result.inFlight = pending;
        return result;
    };
};
