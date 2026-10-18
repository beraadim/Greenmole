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
 * Pans a local desktop view without creating remote mouse/touch input or
 * dismissing its native text editor. Capture listeners decide ownership at
 * touchstart, before any mouse emulation can create a remote button press.
 */
angular.module('client').factory('ClientLocalPan', [function ClientLocalPanFactory() {

    return function ClientLocalPan(element, enabled, onScroll, onStart) {

        const options = { capture: true, passive: false };
        let gesture = null;

        const capture = function capture(event) {
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        const start = function start(event) {
            // A single newly-started contact cannot belong to an older
            // gesture. Its last contact may have ended outside this view (for
            // example on a toolbar), where our listener did not see the end.
            if (event.touches.length === 1)
                gesture = null;

            if (!gesture)
                gesture = { local: !!enabled(), identifier: null };

            // An already-started remote gesture keeps its complete event
            // stream if Pan is enabled before another finger is added.
            if (!gesture.local)
                return;

            capture(event);

            // Own the entire gesture, even if the mode changes before the last
            // finger lifts. A gesture that has used multiple fingers stays
            // blocked instead of unexpectedly becoming a drag or pinch.
            if (gesture.started) {
                gesture.identifier = null;
                return;
            }

            const finger = event.touches.length === 1 ? event.touches[0] : null;
            gesture.started = true;
            if (onStart)
                onStart();
            if (finger) {
                gesture.identifier = finger.identifier;
                gesture.x = finger.clientX;
                gesture.y = finger.clientY;
            }
        };

        const move = function move(event) {
            if (!gesture || !gesture.local)
                return;

            capture(event);
            const finger = event.touches.length === 1 ? event.touches[0] : null;
            if (!finger || finger.identifier !== gesture.identifier) {
                gesture.identifier = null;
                return;
            }

            const deltaX = finger.clientX - gesture.x;
            const deltaY = finger.clientY - gesture.y;
            gesture.x = finger.clientX;
            gesture.y = finger.clientY;

            const previousLeft = element.scrollLeft;
            const previousTop = element.scrollTop;

            // Clamp explicitly, including browsers which expose rubber-band
            // overscroll offsets. Finger movement at an edge must not create
            // a remote wheel event or scroll the page behind the client.
            element.scrollLeft = Math.max(0, Math.min(
                Math.max(0, element.scrollWidth - element.clientWidth),
                previousLeft - deltaX));
            element.scrollTop = Math.max(0, Math.min(
                Math.max(0, element.scrollHeight - element.clientHeight),
                previousTop - deltaY));

            if (element.scrollLeft !== previousLeft || element.scrollTop !== previousTop)
                onScroll(element.scrollLeft, element.scrollTop);
        };

        const end = function end(event) {
            if (!gesture)
                return;

            if (gesture.local)
                capture(event);
            // Never resume from one of the remaining contacts after a partial
            // release/cancel. Wait until all fingers lift before a new pan.
            if (!event.touches.length)
                gesture = null;
            else if (gesture.local)
                gesture.identifier = null;
        };

        element.addEventListener('touchstart', start, options);
        element.addEventListener('touchmove', move, options);
        element.addEventListener('touchend', end, options);
        element.addEventListener('touchcancel', end, options);

        /** Stop moving a detached view without leaking the owned gesture. */
        this.cancel = function cancel() {
            if (gesture)
                gesture.identifier = null;
        };

        this.dispose = function dispose() {
            element.removeEventListener('touchstart', start, options);
            element.removeEventListener('touchmove', move, options);
            element.removeEventListener('touchend', end, options);
            element.removeEventListener('touchcancel', end, options);
            gesture = null;
        };

    };

}]);
