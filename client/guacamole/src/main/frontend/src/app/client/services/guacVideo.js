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

/** Browser-local opt-in and asynchronous capability negotiation for video. */
angular.module('client').factory('guacVideo', ['$injector', function guacVideo($injector) {
    const $q = $injector.get('$q');
    const preferenceService = $injector.get('preferenceService');
    const service = {
        preferences: preferenceService.preferences,
        available: false,
        checked: false,
        secure: !!window.isSecureContext
    };

    service.checkSupport = function checkSupport() {
        return $q.when(Guacamole.AVC420VideoPlayer.checkSupport()).then(function checked(supported) {
            service.available = supported;
            service.checked = true;
            return supported;
        }, function unavailable() {
            service.available = false;
            service.checked = true;
            return false;
        });
    };

    service.save = function save() { preferenceService.save(); };

    // Connection setup waits for this query. No speculative capability is ever
    // sent before WebCodecs confirms support, even with a saved opt-in.
    service.getSupportedMimetypes = function getSupportedMimetypes() {
        if (service.preferences.experimentalAvc420 !== true) return $q.when([]);
        return service.checkSupport().then(function supported(available) {
            return available ? [Guacamole.AVC420VideoPlayer.MIMETYPE] : [];
        });
    };
    service.checkSupport();
    return service;
}]);
