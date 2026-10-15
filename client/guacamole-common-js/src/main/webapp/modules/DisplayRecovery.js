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
 * Bounded recovery of omitted image data using a negotiated private snapshot
 * extension. Stores counters only; image data and error contents are not kept.
 *
 * @constructor
 * @param {!Guacamole.Tunnel} tunnel The connected protocol transport.
 * @param {!function():boolean} isConnected Whether requests may be sent.
 */
Guacamole.DisplayRecovery = function DisplayRecovery(tunnel, isConnected) {

    var supported = false;
    var timer = null;
    var needed = false;
    var nextRequest = 0;
    var failures = 0;
    var requests = 0;
    var automaticRequests = 0;

    // Slightly exceed the server's five-second limit to tolerate transport
    // jitter. A persistently unsupported decoder cannot cause a redraw loop.
    var INTERVAL = 5500;
    var MAX_AUTOMATIC_REQUESTS = 3;

    function clearTimer() {
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
    }

    function sendRequest(automatic) {
        if (!supported || !isConnected() || performance.now() < nextRequest)
            return false;
        if (automatic && automaticRequests >= MAX_AUTOMATIC_REQUESTS)
            return false;

        clearTimer();
        needed = false;
        nextRequest = performance.now() + INTERVAL;
        requests++;
        if (automatic)
            automaticRequests++;
        tunnel.sendMessage('x-resync', '1', 'request');
        return true;
    }

    function scheduleRecovery() {
        if (timer !== null || !needed || !supported || !isConnected()
                || automaticRequests >= MAX_AUTOMATIC_REQUESTS)
            return;

        // Always unwind the decoder/drawing stack before requesting a new
        // snapshot. Many failed tiles in one frame share this single timer.
        timer = window.setTimeout(function recoverDisplay() {
            timer = null;
            if (needed && !sendRequest(true))
                scheduleRecovery();
        }, Math.max(0, Math.ceil(nextRequest - performance.now())));
    }

    /** Record one failed image decode without retaining its payload. */
    this.imageFailed = function imageFailed() {
        if (!isConnected())
            return;
        failures++;
        needed = true;
        scheduleRecovery();
    };

    /** Handles only the private extension version understood by this build. */
    this.handleInstruction = function handleInstruction(parameters) {
        if (parameters.length !== 2 || parameters[0] !== '1')
            return;
        if (parameters[1] === 'ready') {
            supported = true;
            scheduleRecovery();
        }
        else if (parameters[1] === 'busy') {
            needed = true;
            scheduleRecovery();
        }
    };

    /** Requests a manual refresh. Returns false if unsupported/rate-limited. */
    this.request = function request() {
        return sendRequest(false);
    };

    /** Whether the peer explicitly advertised support for snapshot refresh. */
    this.isSupported = function isSupported() {
        return supported && isConnected();
    };

    /** Returns bounded numeric diagnostics without image/error contents. */
    this.getStatistics = function getStatistics() {
        return { imageFailures: failures, refreshRequests: requests,
            automaticRefreshRequests: automaticRequests,
            recoveryPending: needed,
            automaticLimitReached: automaticRequests >= MAX_AUTOMATIC_REQUESTS };
    };

    /** Cancels deferred work and forgets capability/counters on connection reuse. */
    this.reset = function reset() {
        clearTimer();
        supported = false;
        needed = false;
        nextRequest = 0;
        failures = requests = automaticRequests = 0;
    };

};
