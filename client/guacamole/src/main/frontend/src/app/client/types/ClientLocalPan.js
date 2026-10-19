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
 * Pans a local desktop without creating remote input or dismissing its native
 * text editor. Capture listeners fix gesture ownership at touchstart, before
 * any touchscreen or trackpad emulation can create a remote button press.
 *
 * The optional onPinch callback receives an incremental scaleFactor and current
 * and previous midpoint client coordinates. It owns scaling and anchored scroll
 * together, allowing the caller to enforce zoom limits. Without this callback,
 * multi-touch remains blocked for compatibility with pan-only callers.
 */
angular.module('client').factory('ClientLocalPan', [function ClientLocalPanFactory() {

    return function ClientLocalPan(element, enabled, onScroll, onStart, onPinch) {

        const options = { capture: true, passive: false };
        let gesture = null;

        const capture = function capture(event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        const point = function point(finger) {
            if (!Number.isFinite(finger.clientX) || !Number.isFinite(finger.clientY))
                return null;
            return { identifier: finger.identifier, x: finger.clientX, y: finger.clientY };
        };

        // Each contact-count transition establishes a new baseline. Movement
        // across the transition must never become an unintended drag or zoom.
        const rebase = function rebase(touches) {
            gesture.contacts = null;
            if (gesture.cancelled || gesture.blocked)
                return;

            if (touches.length === 1)
                gesture.contacts = [point(touches[0])];
            else if (touches.length === 2 && onPinch)
                gesture.contacts = [point(touches[0]), point(touches[1])];
            else if (!onPinch)
                gesture.blocked = true;

            if (gesture.contacts && gesture.contacts.some(finger => !finger))
                gesture.contacts = null;
        };

        const start = function start(event) {
            // Recover when a previous contact's final event happened outside
            // this view (for example over a toolbar).
            if (event.touches.length === 1)
                gesture = null;

            if (!gesture) {
                gesture = { local: !!enabled(), contacts: null };
                if (gesture.local && onStart)
                    onStart();
            }

            // A remote gesture keeps its entire stream even if Pan is enabled
            // before another finger is added. An owned local gesture likewise
            // stays local until its final contact ends after Pan is disabled,
            // but cancelled movement cannot resume on the remaining contacts.
            if (!gesture.local)
                return;

            capture(event);
            if (!enabled())
                gesture.cancelled = true;
            rebase(event.touches);
        };

        const move = function move(event) {
            if (!gesture || !gesture.local)
                return;

            capture(event);
            if (!enabled())
                gesture.cancelled = true;
            if (gesture.cancelled || gesture.blocked)
                return;

            const previous = gesture.contacts;
            if (!previous || previous.length !== event.touches.length) {
                rebase(event.touches);
                return;
            }

            // Browser TouchList order is not a contact identity. Preserve the
            // original pair even if the browser reverses its ordering.
            const current = previous.map(old => {
                for (let i = 0; i < event.touches.length; i++) {
                    if (event.touches[i].identifier === old.identifier)
                        return point(event.touches[i]);
                }
                return null;
            });
            if (current.some(finger => !finger)) {
                rebase(event.touches);
                return;
            }
            gesture.contacts = current;

            if (current.length === 2) {
                const previousDistance = Math.hypot(
                    previous[1].x - previous[0].x, previous[1].y - previous[0].y);
                const distance = Math.hypot(
                    current[1].x - current[0].x, current[1].y - current[0].y);
                if (!previousDistance || !distance)
                    return;

                const change = {
                    scaleFactor: distance / previousDistance,
                    clientX: (current[0].x + current[1].x) / 2,
                    clientY: (current[0].y + current[1].y) / 2,
                    previousClientX: (previous[0].x + previous[1].x) / 2,
                    previousClientY: (previous[0].y + previous[1].y) / 2
                };
                if (Number.isFinite(change.scaleFactor)
                        && (change.scaleFactor !== 1
                            || change.clientX !== change.previousClientX
                            || change.clientY !== change.previousClientY))
                    onPinch(change);
                return;
            }

            const previousLeft = element.scrollLeft;
            const previousTop = element.scrollTop;

            // Clamp even browsers' rubber-band offsets. Edge movement must not
            // scroll the surrounding page or become a remote wheel event.
            element.scrollLeft = Math.max(0, Math.min(
                Math.max(0, element.scrollWidth - element.clientWidth),
                previousLeft - (current[0].x - previous[0].x)));
            element.scrollTop = Math.max(0, Math.min(
                Math.max(0, element.scrollHeight - element.clientHeight),
                previousTop - (current[0].y - previous[0].y)));

            if (element.scrollLeft !== previousLeft || element.scrollTop !== previousTop)
                onScroll(element.scrollLeft, element.scrollTop);
        };

        const end = function end(event) {
            if (!gesture)
                return;
            if (gesture.local) {
                capture(event);
                if (!enabled())
                    gesture.cancelled = true;
            }
            if (!event.touches.length)
                gesture = null;
            else if (gesture.local)
                rebase(event.touches);
        };

        const cancelTouch = function cancelTouch(event) {
            if (gesture && gesture.local)
                gesture.cancelled = true;
            end(event);
        };

        element.addEventListener('touchstart', start, options);
        element.addEventListener('touchmove', move, options);
        element.addEventListener('touchend', end, options);
        element.addEventListener('touchcancel', cancelTouch, options);

        /** Cancel motion while retaining local ownership through final release. */
        this.cancel = function cancel() {
            if (gesture) {
                gesture.cancelled = true;
                gesture.contacts = null;
            }
        };

        this.dispose = function dispose() {
            element.removeEventListener('touchstart', start, options);
            element.removeEventListener('touchmove', move, options);
            element.removeEventListener('touchend', end, options);
            element.removeEventListener('touchcancel', cancelTouch, options);
            gesture = null;
        };

    };

}]);
