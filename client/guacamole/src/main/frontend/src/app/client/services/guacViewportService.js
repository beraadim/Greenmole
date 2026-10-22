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
    var keyboardOcclusionObserved = false;
    var panDismissTimer = null;
    var keyboardIndicatorObserved = false;
    var keyboardIndicatorDismissTimer = null;

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

    function cancelPanDismissal() {
        if (panDismissTimer !== null) {
            $window.clearTimeout(panDismissTimer);
            panDismissTimer = null;
        }
    }

    function cancelKeyboardIndicatorDismissal() {
        if (keyboardIndicatorDismissTimer !== null) {
            $window.clearTimeout(keyboardIndicatorDismissTimer);
            keyboardIndicatorDismissTimer = null;
        }
    }

    // Focus is only keyboard intent on iOS. Track a confirmed opening and
    // settled dismissal independently of Pan, which may have been turned off.
    function observeKeyboardIndicator(intent, widthChanged, zoomed, inset) {
        cancelKeyboardIndicatorDismissal();
        if (!intent || !guacNativeKeyboard.keyboardOpen || widthChanged || zoomed) {
            keyboardIndicatorObserved = false;
            return;
        }
        if (inset >= 120)
            keyboardIndicatorObserved = true;
        if (keyboardIndicatorObserved && inset <= 80 && panDismissTimer === null) {
            keyboardIndicatorDismissTimer = $window.setTimeout(function() {
                keyboardIndicatorDismissTimer = null;
                keyboardIndicatorObserved = false;
                guacNativeKeyboard.setKeyboardOpen(false);
            }, 150);
        }
    }

    /** iPadOS can dismiss its keyboard without blurring the native editor. */
    function observeKeyboardPan(intent, widthChanged, zoomed, inset) {
        cancelPanDismissal();
        if (!intent || !guacNativeKeyboard.panning || widthChanged || zoomed) {
            keyboardOcclusionObserved = false;
            return;
        }
        // Show focuses the editor before any keyboard inset exists. Only a
        // keyboard-sized occlusion arms automatic dismissal; browser chrome
        // changes alone must leave a deliberately selected Pan mode alone.
        if (inset >= 120)
            keyboardOcclusionObserved = true;
        if (keyboardOcclusionObserved && inset <= 80) {
            panDismissTimer = $window.setTimeout(function() {
                panDismissTimer = null;
                // Consume this opening before notifying subscribers. The
                // resulting synchronous viewport update cannot arm another
                // dismissal or override a later manual Pan selection.
                keyboardOcclusionObserved = false;
                keyboardIndicatorObserved = false;
                cancelKeyboardIndicatorDismissal();
                guacNativeKeyboard.setKeyboardOpen(false);
                guacNativeKeyboard.setPanning(false);
            }, 150);
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
        var zoomed = visual && Math.abs((visual.scale || 1) - 1) > 0.01;
        var widthChanged = lastWidth && Math.abs(width - lastWidth) > 1;

        // A browser pinch changes the visible rectangle without changing the
        // available desktop. Keep its last geometry, but still publish native
        // input controls/toolbar state. An already-pinched first subscription
        // has no prior geometry, so initialize from the full layout viewport.
        var zoomGeometry = zoomed && !widthChanged ? state : null;

        var visibleHeight = zoomGeometry ? zoomGeometry.height
            : (visual && !zoomed && visual.height > 0 ? visual.height : height);
        var visibleWidth = zoomGeometry ? zoomGeometry.width
            : (visual && !zoomed && visual.width > 0 ? visual.width : width);

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

        var preserveLayout = holdingKeyboard;
        if (!preserveLayout && state && state.preserveLayout && !allowLayoutRelease) {
            // Let keyboard dismissal and native-mode toolbar teardown finish
            // applying their styles before accepting an unoccluded layout.
            preserveLayout = true;
            frame = requestFrame(function() { update(false, true); });
        }
        lastWidth = width;
        var keyboardInset = holdingKeyboard ? Math.max(0, fullHeight - visibleHeight) : 0;
        observeKeyboardPan(intent, widthChanged, zoomed, keyboardInset);
        observeKeyboardIndicator(intent, widthChanged, zoomed, keyboardInset);
        publish({
            // Browser chrome can reduce the visible area in every input mode,
            // including None. Using innerHeight there would size the remote
            // desktop behind Safari's toolbar and put its dock out of reach.
            width: visibleWidth,
            height: visibleHeight,
            left: zoomGeometry ? zoomGeometry.left
                : (visual && !zoomed ? (visual.pageLeft || 0) : null),
            top: zoomGeometry ? zoomGeometry.top
                : (visual && !zoomed ? (visual.pageTop || 0) : null),
            keyboardInset: keyboardInset,
            // The permanent toolbar occupies layout space. The software
            // keyboard only clips that bar-adjusted desktop. Publish focus
            // intent before the keyboard animation has reported an inset.
            preserveLayout: preserveLayout,
            keyboardActive: holdingKeyboard,
            keyboardFocused: intent,
            keyboardOpen: nativeEnabled && !!guacNativeKeyboard.keyboardOpen,
            layoutWidth: width,
            layoutReady: !nativeEnabled || guacNativeKeyboard.toolbarHeight > 0,
            panning: nativeEnabled && !!guacNativeKeyboard.panning,
            toolbarHeight: nativeEnabled ? (guacNativeKeyboard.toolbarHeight || 0) : 0
        });
    }

    function schedule() {
        cancelSettle();
        cancelPanDismissal();
        cancelKeyboardIndicatorDismissal();
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
        cancelPanDismissal();
        cancelKeyboardIndicatorDismissal();
        if (frame !== null)
            cancelFrame(frame);
        frame = null;
        state = null;
        fullHeight = 0;
        lastWidth = 0;
        holdingKeyboard = false;
        keyboardOcclusionObserved = false;
        keyboardIndicatorObserved = false;
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

        /** Restore only software-keyboard occlusion; the toolbar is in flow. */
        getRemoteSize: function(width, height, rows, previous) {
            // A remembered native preference can render the client before its
            // toolbar. Wait for the actual measured row instead of connecting
            // once at full browser height and resizing immediately afterwards.
            if (state && !state.layoutReady)
                return null;
            var inset = state ? state.keyboardInset : 0;
            if (state && state.preserveLayout && previous) {
                // Reuse the unoccluded dimensions above the toolbar. Safari's
                // focus scrolling and asynchronous viewport events must not
                // resize this desktop. The client invalidates the baseline
                // when the permanent toolbar or tiled layout really changes.
                return { width: previous.width, height: previous.height };
            }
            return {
                width: width,
                height: Math.round(height + inset / Math.max(rows || 1, 1))
            };
        }

    };
}]);
