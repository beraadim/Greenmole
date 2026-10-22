/*
 * Modified for Greenmole by its maintainers.
 *
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
 * Native keyboard intent shared by the input UI and viewport layout. A focused
 * editor does not guarantee a visible software keyboard (hardware keyboards and
 * the iPad floating keyboard may leave the viewport unchanged).
 */
angular.module('textInput').factory('guacNativeKeyboard', ['$window', function guacNativeKeyboard($window) {

    var navigator = $window.navigator || {};
    var subscribers = [];
    var service = {
        isIPad: /iPad/i.test(navigator.userAgent || '')
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
        enabled: false,
        focused: false,
        keyboardOpen: false,
        panning: false,
        scrolling: false,
        toolbarHeight: 0
    };

    var notify = function notify() {
        subscribers.slice().forEach(function notifySubscriber(callback) {
            callback();
        });
    };

    service.setEnabled = function setEnabled(enabled) {
        enabled = !!enabled;
        if (service.enabled !== enabled) {
            service.enabled = enabled;
            if (!enabled) {
                service.focused = false;
                service.keyboardOpen = false;
                service.panning = false;
                service.scrolling = false;
                service.toolbarHeight = 0;
            }
            notify();
        }
    };

    service.setFocused = function setFocused(focused) {
        focused = service.enabled && !!focused;
        if (service.focused !== focused
                || (!focused && (service.keyboardOpen || service.panning || service.scrolling))) {
            service.focused = focused;
            service.keyboardOpen = focused;
            if (!focused) {
                service.panning = false;
                service.scrolling = false;
            }
            notify();
        }
    };

    /** iOS may dismiss its keyboard while the mounted editor keeps focus. */
    service.setKeyboardOpen = function setKeyboardOpen(open) {
        open = service.enabled && service.focused && !!open;
        if (service.keyboardOpen !== open) {
            service.keyboardOpen = open;
            notify();
        }
    };

    /** Pan mode belongs to this session and always starts disabled. */
    service.setPanning = function setPanning(panning) {
        panning = service.enabled && !!panning;
        if (service.panning !== panning || (panning && service.scrolling)) {
            service.panning = panning;
            if (panning)
                service.scrolling = false;
            notify();
        }
    };

    /** Remote scrolling and local Pan/zoom never own a touch simultaneously. */
    service.setScrolling = function setScrolling(scrolling) {
        scrolling = service.enabled && !!scrolling;
        if (service.scrolling !== scrolling || (scrolling && service.panning)) {
            service.scrolling = scrolling;
            if (scrolling)
                service.panning = false;
            notify();
        }
    };

    /** Actual permanent control-strip height, reserved once by the flex layout. */
    service.setToolbarHeight = function setToolbarHeight(height) {
        height = service.enabled && typeof height === 'number' && isFinite(height)
            ? Math.max(0, Math.ceil(height)) : 0;
        if (service.toolbarHeight !== height) {
            service.toolbarHeight = height;
            notify();
        }
    };

    service.subscribe = function subscribe(callback) {
        subscribers.push(callback);
        return function unsubscribe() {
            var index = subscribers.indexOf(callback);
            if (index !== -1)
                subscribers.splice(index, 1);
        };
    };

    return service;

}]);
