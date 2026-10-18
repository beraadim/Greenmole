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
        panning: false,
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
                service.panning = false;
                service.toolbarHeight = 0;
            }
            notify();
        }
    };

    service.setFocused = function setFocused(focused) {
        focused = service.enabled && !!focused;
        if (service.focused !== focused) {
            service.focused = focused;
            notify();
        }
    };

    /** Pan mode belongs to this session and always starts disabled. */
    service.setPanning = function setPanning(panning) {
        panning = service.enabled && !!panning;
        if (service.panning !== panning) {
            service.panning = panning;
            notify();
        }
    };

    /** Actual overlay height; never subtract this from the remote desktop. */
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
