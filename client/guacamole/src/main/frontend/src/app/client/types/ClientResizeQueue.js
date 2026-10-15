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

/**
 * Coalesces viewport changes without delaying local scaling or input. At most
 * one desired size and one outstanding request are retained. Missing resize
 * acknowledgements receive bounded retries instead of suppressing that size
 * forever or continually reactivating a server which does not support resize.
 */
angular.module('client').factory('ClientResizeQueue', ['$window', function ClientResizeQueueFactory($window) {

    const SETTLE_DELAY = 150;
    const MAX_SETTLE_DELAY = 500;
    const ACK_DELAY = 1500;
    const MAX_ATTEMPTS = 3;

    const same = (a, b) => a && b && a.width === b.width && a.height === b.height;
    const now = () => $window.performance ? $window.performance.now() : Date.now();

    const ClientResizeQueue = function ClientResizeQueue(send) {

        let connected = false;
        let disposed = false;
        let desired = null;
        let observed = null;
        let pending = null;
        let timer = null;
        let batchStarted = null;
        let quietUntil = 0;
        let attempts = 0;

        const cancelTimer = function cancelTimer() {
            if (timer !== null)
                $window.clearTimeout(timer);
            timer = null;
        };

        const schedule = function schedule(deadline) {
            cancelTimer();
            timer = $window.setTimeout(update, Math.max(0, deadline - now()));
        };

        const update = function update() {
            cancelTimer();
            if (!connected || disposed || !desired)
                return;

            // An earlier outstanding request can still override the observed
            // size. Send the latest desired size even if it currently matches.
            if (same(desired, observed) && (!pending || same(pending, desired))) {
                pending = null;
                batchStarted = null;
                return;
            }

            if (same(pending, desired)) {
                if (attempts >= MAX_ATTEMPTS)
                    return;
                if (now() < pending.sentAt + ACK_DELAY) {
                    schedule(pending.sentAt + ACK_DELAY);
                    return;
                }
            }
            else {
                const deadline = batchStarted === null ? now()
                    : Math.min(quietUntil, batchStarted + MAX_SETTLE_DELAY);
                if (now() < deadline) {
                    schedule(deadline);
                    return;
                }
            }

            attempts++;
            pending = { width: desired.width, height: desired.height, sentAt: now() };
            const request = pending;
            batchStarted = null;
            send(desired.width, desired.height);
            if (pending === request && connected && !disposed && attempts < MAX_ATTEMPTS)
                schedule(pending.sentAt + ACK_DELAY);
        };

        /** Records the latest viewport. Duplicate events do not extend settling. */
        this.request = function request(width, height) {
            if (disposed || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
                    || width <= 0 || height <= 0)
                return;

            const size = { width, height };
            if (!same(desired, size)) {
                desired = size;
                attempts = 0;
                if (batchStarted === null)
                    batchStarted = now();
                quietUntil = now() + SETTLE_DELAY;
            }
            else if (same(pending, desired) && attempts >= MAX_ATTEMPTS
                    && now() >= pending.sentAt + ACK_DELAY) {
                // Stop retrying an uncooperative server in the background, but
                // let a later viewport notification retry an expired request.
                pending = null;
                attempts = 0;
                batchStarted = now();
                quietUntil = now() + SETTLE_DELAY;
            }
            update();
        };

        /** Records the actual remote display size without changing input scale. */
        this.acknowledge = function acknowledge(width, height) {
            observed = { width, height };
            if (same(pending, observed))
                pending = null;
            update();
        };

        /** Retains the latest viewport while the initial handshake is pending. */
        this.setConnected = function setConnected(value) {
            connected = !!value;
            update();
        };

        /** Cancels all work belonging to a detached client. */
        this.clear = function clear() {
            cancelTimer();
            connected = false;
            desired = observed = pending = null;
            batchStarted = null;
            quietUntil = attempts = 0;
        };

        this.dispose = function dispose() {
            this.clear();
            disposed = true;
        };

    };

    /** Matches handshake pixel rounding and the RDP display channel's width. */
    ClientResizeQueue.normalize = function normalize(width, height, density, evenWidth) {
        if (!Number.isFinite(density) || density <= 0)
            density = 1;
        width = Math.floor(width * density);
        height = Math.floor(height * density);
        if (evenWidth)
            width -= width % 2;
        return { width, height };
    };

    return ClientResizeQueue;

}]);
