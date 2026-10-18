/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information regarding
 * copyright ownership. The ASF licenses this file under the Apache
 * License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { eventBus } = require('./client-fixtures');

const source = fs.readFileSync(path.join(__dirname,
    '../../src/app/settings/services/preferenceService.js'), 'utf8');

function fixture(storedPreferences) {
    let stored = storedPreferences;
    const saves = [];
    return {
        saves,
        get stored() { return stored; },
        load(navigator = {}) {
            const provider = {};
            vm.runInNewContext(source, {
                navigator,
                jstz: { determine: () => ({ name: () => 'Europe/Oslo' }) },
                angular: {
                    extend: Object.assign,
                    module: () => ({ provider(name, definition) {
                        assert.equal(name, 'preferenceService');
                        definition.at(-1).call(provider, { get: name => {
                            assert.equal(name, 'localStorageServiceProvider');
                            return { getItem(key) {
                                assert.equal(key, 'GUAC_PREFERENCES');
                                return stored === undefined ? null : JSON.parse(JSON.stringify(stored));
                            } };
                        } });
                    } })
                }
            });
            const root = eventBus();
            let unload;
            const services = {
                $rootScope: root,
                $window: { addEventListener(name, listener) {
                    assert.equal(name, 'unload');
                    unload = listener;
                } },
                localStorageService: { setItem(key, value) {
                    assert.equal(key, 'GUAC_PREFERENCES');
                    stored = JSON.parse(JSON.stringify(value));
                    saves.push(stored);
                } }
            };
            return { service: provider.$get.at(-1)({ get: name => services[name] }),
                root, unload: () => unload() };
        }
    };
}


/** Run the actual page controller without authentication, tunnels or routing. */
function clientControllerFixture(preferences) {
    let controller;
    const scope = eventBus();
    const watches = new Map();
    scope.$watch = (expression, callback) => watches.set(expression, callback);
    scope.$apply = callback => callback();
    const keyboard = { enabled: false, setEnabled(value) { this.enabled = value; } };
    const services = {
        ConnectionGroup: { ROOT_IDENTIFIER: 'ROOT' },
        ManagedClient: {},
        ManagedClientGroup: {},
        ManagedClientState: { ConnectionState: {} },
        ManagedFilesystem: {},
        Protocol: {},
        ScrollState: function ScrollState() {},
        $location: {},
        authenticationService: { getAvailableDataSources: () => [] },
        connectionGroupService: {},
        clipboardService: { resyncClipboard() {} },
        dataSourceService: { apply: () => ({ then() {} }) },
        guacClientManager: { getManagedClientGroup: () => ({ clients: [] }) },
        guacFullscreen: {},
        guacNativeKeyboard: keyboard,
        iconService: {},
        preferenceService: preferences,
        requestService: {},
        tunnelService: {},
        userPageService: {},
        guacVideo: {}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,
        '../../src/app/client/controllers/clientController.js'), 'utf8'), {
        angular: { extend: Object.assign, module: () => ({ controller(name, definition) {
            assert.equal(name, 'clientController');
            controller = definition.at(-1);
        } }) },
        _: { intersection: () => [], isEmpty: value => !value.length }
    });
    controller(scope, { id: 'synthetic' }, { get: name => {
        assert.ok(name in services, 'Unstubbed dependency: ' + name);
        return services[name];
    } });
    return { scope, watches, keyboard };
}

module.exports = { preferenceFixture: fixture, clientControllerFixture };
