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

// Modified for Greenmole by its maintainers.

/**
 * Converts an explicitly selected one-finger drag into remote wheel notches.
 * Capture fixes ownership before native touch/mouse emulation. An owned stream
 * stays captured through release even if its mode is disabled or cancelled.
 * The callback owns atomic wheel press/release and the clipboard input gate.
 */
angular.module('client').factory('ClientTouchScroll', [function ClientTouchScrollFactory() {

    return function ClientTouchScroll(element, enabled, onWheel, view) {

        const options = { capture: true, passive: false };
        const PIXELS_PER_NOTCH = 20;
        const MAX_PENDING = PIXELS_PER_NOTCH * 4;
        const INTERVAL = 16;
        let gesture = null;
        let pendingX = 0;
        let pendingY = 0;
        let timer = null;
        let lastFlush = -INTERVAL;
        let disposed = false;

        const now = () => view.performance && view.performance.now
            ? view.performance.now() : Date.now();

        const capture = event => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        const point = finger => finger && Number.isFinite(finger.clientX)
                && Number.isFinite(finger.clientY)
            ? { identifier: finger.identifier, x: finger.clientX, y: finger.clientY } : null;

        const clearPending = () => {
            if (timer !== null)
                view.clearTimeout(timer);
            timer = null;
            pendingX = pendingY = 0;
        };

        const cancel = () => {
            clearPending();
            if (gesture) {
                gesture.cancelled = true;
                gesture.contact = null;
            }
        };

        const hasNotches = () => Math.abs(pendingX) >= PIXELS_PER_NOTCH
            || Math.abs(pendingY) >= PIXELS_PER_NOTCH;

        const schedule = () => {
            if (timer === null && hasNotches())
                timer = view.setTimeout(() => {
                    timer = null;
                    flush();
                }, Math.max(0, INTERVAL - (now() - lastFlush)));
        };

        const flush = () => {
            const owner = gesture;
            if (disposed || !owner || !owner.local || owner.cancelled
                    || owner.blocked || !enabled()) {
                cancel();
                return;
            }
            if (!hasNotches())
                return;
            const timestamp = now();
            if (timestamp - lastFlush < INTERVAL) {
                schedule();
                return;
            }

            let availableX = Math.trunc(pendingX / PIXELS_PER_NOTCH);
            let availableY = Math.trunc(pendingY / PIXELS_PER_NOTCH);
            let dx = 0;
            let dy = 0;
            // At most two notches total per interval, balancing diagonal drags.
            // Saturation above prevents a jump/long task from building a backlog.
            for (let budget = 2; budget > 0 && (availableX || availableY); budget--) {
                if (Math.abs(availableX) > Math.abs(availableY)) {
                    const step = Math.sign(availableX);
                    dx += step;
                    availableX -= step;
                }
                else {
                    const step = Math.sign(availableY);
                    dy += step;
                    availableY -= step;
                }
            }
            pendingX -= dx * PIXELS_PER_NOTCH;
            pendingY -= dy * PIXELS_PER_NOTCH;
            lastFlush = timestamp;
            onWheel(dx, dy);
            if (!disposed && gesture === owner && !owner.cancelled
                    && !owner.blocked && enabled())
                schedule();
        };

        const start = event => {
            if (disposed)
                return;
            // Recover when an earlier contact finished outside this view.
            if (event.touches.length === 1) {
                clearPending();
                gesture = null;
            }
            if (!gesture)
                gesture = { local: !!enabled(), contact: null };
            if (!gesture.local)
                return;
            capture(event);
            if (!enabled())
                cancel();
            if (event.touches.length !== 1) {
                gesture.blocked = true;
                clearPending();
            }
            if (!gesture.cancelled && !gesture.blocked)
                gesture.contact = point(event.touches[0]);
        };

        const move = event => {
            if (disposed || !gesture || !gesture.local)
                return;
            capture(event);
            if (!enabled())
                cancel();
            if (gesture.cancelled || gesture.blocked)
                return;
            if (event.touches.length !== 1) {
                gesture.blocked = true;
                clearPending();
                return;
            }
            const previous = gesture.contact;
            const current = point(event.touches[0]);
            gesture.contact = current;
            if (!previous || !current || previous.identifier !== current.identifier) {
                clearPending();
                return;
            }
            // Positive wheel direction follows the usual direct-touch gesture:
            // dragging content up/left scrolls farther down/right remotely.
            pendingX = Math.max(-MAX_PENDING, Math.min(MAX_PENDING,
                pendingX + previous.x - current.x));
            pendingY = Math.max(-MAX_PENDING, Math.min(MAX_PENDING,
                pendingY + previous.y - current.y));
            flush();
        };

        const end = event => {
            if (disposed || !gesture)
                return;
            if (gesture.local) {
                capture(event);
                cancel();
            }
            if (!event.touches.length)
                gesture = null;
        };

        element.addEventListener('touchstart', start, options);
        element.addEventListener('touchmove', move, options);
        element.addEventListener('touchend', end, options);
        element.addEventListener('touchcancel', end, options);

        /** Stop motion without handing remaining contacts to remote emulators. */
        this.cancel = cancel;

        this.dispose = () => {
            disposed = true;
            cancel();
            gesture = null;
            element.removeEventListener('touchstart', start, options);
            element.removeEventListener('touchmove', move, options);
            element.removeEventListener('touchend', end, options);
            element.removeEventListener('touchcancel', end, options);
        };

    };

}]);
