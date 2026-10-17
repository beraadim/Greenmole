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

/** Browser-local opt-in and asynchronous capability negotiation for video. */
angular.module('client').factory('guacVideo', ['$injector', function guacVideo($injector) {
    const $q = $injector.get('$q');
    const preferenceService = $injector.get('preferenceService');
    const preferences = preferenceService.preferences;
    // Preserve old explicit opt-ins as AVC420. Invalid/unknown saved values
    // never enable video implicitly.
    const mode = ['images', 'avc420', 'avc444'].indexOf(preferences.experimentalVideoMode) !== -1
        ? preferences.experimentalVideoMode : preferences.experimentalVideoMode == null && preferences.experimentalAvc420 === true ? 'avc420' : 'images';
    const service = { preferences, mode, available: false, avc420Available: false,
        avc444Available: false, checked: false, secure: !!window.isSecureContext };
    service.checkSupport = function checkSupport() {
        const checks = [Guacamole.AVC420VideoPlayer, service.mode === 'avc444' ? Guacamole.AVC444VideoPlayer : null].map(function probe(Player) {
            return $q.when(Player ? Player.checkSupport() : false).then(function supported(value) { return value === true; }, function unavailable() { return false; });
        });
        return $q.all(checks).then(function checked(values) {
            service.avc420Available = values[0]; service.avc444Available = values[1];
            service.available = service.mode === 'avc444' ? values[1] : values[0]; service.checked = true;
            return values;
        });
    };
    service.save = function save() {
        if (['images', 'avc420', 'avc444'].indexOf(service.mode) === -1) service.mode = 'images';
        preferences.experimentalVideoMode = service.mode;
        preferences.experimentalAvc420 = service.mode === 'avc420';
        preferenceService.save();
        service.available = service.mode === 'avc444' ? service.avc444Available : service.avc420Available;
        service.checkSupport();
    };
    service.getSupportedMimetypes = function getSupportedMimetypes() {
        if (service.mode === 'images') return $q.when([]);
        const selected = service.mode;
        return service.checkSupport().then(function supported(available) {
            const types = [];
            if (selected === 'avc444' && available[1]) types.push(Guacamole.AVC444VideoPlayer.MIMETYPE);
            // A host still configured for AVC420 can retain its existing fast
            // path, and a failed native-plane probe never advertises AVC444.
            if (available[0]) types.push(Guacamole.AVC420VideoPlayer.MIMETYPE);
            return types;
        });
    };
    service.checkSupport();
    return service;
}]);
