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
 * Tracks the visible client area independently of the remote desktop size.
 * Native keyboards may shrink only VisualViewport, or both viewports. Holding
 * the pre-keyboard height prevents either behavior from resizing the desktop.
 */
angular.module('client').factory('guacViewportService', ['$window', 'guacNativeKeyboard',
    function guacViewportService($window, guacNativeKeyboard) {

    var subscribers = [];
    var visual = $window.visualViewport;
    var frame = null;
    var settleTimer = null;
    var unsubscribeKeyboard = null;
    var state = null;
    var fullHeight = 0;
    var lastWidth = 0;
    var holdingKeyboard = false;

    var requestFrame = $window.requestAnimationFrame
        ? function(callback) { return $window.requestAnimationFrame(callback); }
        : function(callback) { return $window.setTimeout(callback, 16); };
    var cancelFrame = $window.cancelAnimationFrame
        ? function(id) { $window.cancelAnimationFrame(id); }
        : function(id) { $window.clearTimeout(id); };

    function cancelSettle() {
        if (settleTimer !== null) {
            $window.clearTimeout(settleTimer);
            settleTimer = null;
        }
    }

    function publish(next) {
        var changed = !state || Object.keys(next).some(function(key) {
            return next[key] !== state[key];
        });
        state = next;
        if (changed)
            subscribers.slice().forEach(function(callback) { callback(next); });
    }

    function update(allowSettledRelease, allowLayoutRelease) {
        frame = null;
        cancelSettle();

        var width = $window.innerWidth;
        var height = $window.innerHeight;
        if (!(width > 0 && height > 0))
            return;

        var nativeEnabled = guacNativeKeyboard.enabled;
        var intent = nativeEnabled && guacNativeKeyboard.focused;
        var nativeLayout = nativeEnabled || holdingKeyboard;
        var zoomed = visual && Math.abs((visual.scale || 1) - 1) > 0.01;
        var widthChanged = lastWidth && Math.abs(width - lastWidth) > 1;

        // A browser pinch changes the visible rectangle without changing the
        // available desktop. Keep its last geometry, but still publish native
        // input controls/toolbar state. An already-pinched first subscription
        // has no prior geometry, so initialize from the full layout viewport.
        var zoomGeometry = nativeLayout && zoomed && !widthChanged ? state : null;

        var visibleHeight = zoomGeometry ? zoomGeometry.height
            : (nativeLayout && visual && !zoomed && visual.height > 0 ? visual.height : height);
        var visibleWidth = zoomGeometry ? zoomGeometry.width
            : (nativeLayout && visual && !zoomed && visual.width > 0 ? visual.width : width);

        if (!holdingKeyboard || widthChanged) {
            // Width changes indicate rotation or multitasking, rather than a
            // keyboard animation. Adopt the new layout viewport immediately.
            fullHeight = widthChanged ? Math.max(height, visibleHeight)
                : (intent && state ? state.height : visibleHeight);
        }

        if (intent)
            holdingKeyboard = true;

        // Some browsers resize innerHeight as well as VisualViewport. Keep the
        // captured height while focused and during the dismissal animation.
        if (holdingKeyboard) {
            fullHeight = Math.max(fullHeight, visibleHeight);
            if (!intent && (visibleHeight >= fullHeight - 2
                    || (allowSettledRelease && fullHeight - visibleHeight < 80))) {
                holdingKeyboard = false;
                fullHeight = visibleHeight;
            }
            else if (!intent && !allowSettledRelease) {
                // A small remaining difference may be browser chrome. Wait for
                // the animation to stop before accepting it, and never release
                // a keyboard-sized occlusion just because focus was lost.
                settleTimer = $window.setTimeout(function() {
                    settleTimer = null;
                    update(true);
                }, 250);
            }
        }

        nativeLayout = nativeEnabled || holdingKeyboard;
        var preserveLayout = nativeLayout;
        if (!preserveLayout && state && state.preserveLayout && !allowLayoutRelease) {
            // Disabling native mode removes its Angular toolbar in the next
            // digest. Keep the baseline until the resulting styles have been
            // applied, rather than resizing once to the departing toolbar.
            preserveLayout = true;
            frame = requestFrame(function() { update(false, true); });
        }
        lastWidth = width;
        publish({
            width: nativeLayout ? visibleWidth : width,
            height: nativeLayout ? visibleHeight : height,
            left: nativeLayout && zoomGeometry ? zoomGeometry.left
                : (nativeLayout && visual && !zoomed ? (visual.pageLeft || 0) : null),
            top: nativeLayout && zoomGeometry ? zoomGeometry.top
                : (nativeLayout && visual && !zoomed ? (visual.pageTop || 0) : null),
            keyboardInset: holdingKeyboard ? Math.max(0, fullHeight - visibleHeight) : 0,
            // Native text input and its toolbar reduce only the local view.
            // Publish intent before keyboard animation has reported an inset.
            preserveLayout: preserveLayout,
            keyboardActive: holdingKeyboard,
            keyboardFocused: intent,
            layoutWidth: width,
            panning: nativeEnabled && !!guacNativeKeyboard.panning,
            toolbarHeight: nativeEnabled ? (guacNativeKeyboard.toolbarHeight || 0) : 0
        });
    }

    function schedule() {
        cancelSettle();
        if (frame === null)
            frame = requestFrame(function() { update(false); });
    }

    function start() {
        $window.addEventListener('resize', schedule);
        $window.addEventListener('scroll', schedule);
        if (visual) {
            visual.addEventListener('resize', schedule);
            visual.addEventListener('scroll', schedule);
        }
        unsubscribeKeyboard = guacNativeKeyboard.subscribe(function() {
            // Capture the pre-animation height synchronously on focus.
            if (frame !== null) {
                cancelFrame(frame);
                frame = null;
            }
            update(false);
        });
        update(false);
    }

    function stop() {
        $window.removeEventListener('resize', schedule);
        $window.removeEventListener('scroll', schedule);
        if (visual) {
            visual.removeEventListener('resize', schedule);
            visual.removeEventListener('scroll', schedule);
        }
        unsubscribeKeyboard();
        unsubscribeKeyboard = null;
        cancelSettle();
        if (frame !== null)
            cancelFrame(frame);
        frame = null;
        state = null;
        fullHeight = 0;
        lastWidth = 0;
        holdingKeyboard = false;
    }

    return {

        /** Observe visible geometry; listeners exist only while subscribed. */
        subscribe: function(callback) {
            subscribers.push(callback);
            if (subscribers.length === 1)
                start();
            else if (state)
                callback(state);
            var subscribed = true;
            return function() {
                if (!subscribed)
                    return;
                subscribed = false;
                subscribers.splice(subscribers.indexOf(callback), 1);
                if (!subscribers.length)
                    stop();
            };
        },

        /** Exclude native input UI and keyboard occlusion from remote size. */
        getRemoteSize: function(width, height, rows, previous) {
            var inset = state ? state.keyboardInset : 0;
            if (state && state.preserveLayout && previous) {
                // Reuse both dimensions from before native mode. Its input
                // bar, Safari's focus scrolling, and asynchronous viewport
                // events must never change the remote desktop. The client
                // invalidates this baseline for real layout width/row changes.
                return { width: previous.width, height: previous.height };
            }
            return {
                width: width,
                height: Math.round(height + inset / Math.max(rows || 1, 1))
            };
        }

    };
}]);
