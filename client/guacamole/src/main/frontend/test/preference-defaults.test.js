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
const test = require('node:test');
const { preferenceFixture: fixture } = require('./helpers/preference-fixtures');

const devices = [
    { name: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' },
    { name: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    { name: 'iPod', userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)' },
    { name: 'desktop-UA iPad', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
        platform: 'MacIntel', maxTouchPoints: 5 }
];

test('fresh iOS browsers default to native keyboard and relative mouse before a session is created', () => {
    for (const device of devices) {
        const storage = fixture();
        const { service } = storage.load(device);
        assert.equal(service.preferences.inputMethod, 'native', device.name);
        assert.equal(service.preferences.emulateAbsoluteMouse, false, device.name);
        assert.equal(storage.stored.iosTouchpadDefaultVersion, 1);
        assert.equal(storage.saves.length, 1, 'migration must be committed before the first navigation');
    }
});

test('non-iOS browsers retain physical keyboard and absolute touch defaults', () => {
    for (const device of [
        {},
        { platform: 'MacIntel', maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Macintosh)' },
        { platform: 'MacIntel', maxTouchPoints: 1 },
        { platform: 'Win32', maxTouchPoints: 10, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
        { platform: 'Linux armv8l', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 15)' }
    ]) {
        const { service } = fixture().load(device);
        assert.equal(service.preferences.inputMethod, 'none');
        assert.equal(service.preferences.emulateAbsoluteMouse, true);
    }
});

test('versioned saved input and mouse choices override iOS defaults independently', () => {
    for (const device of devices) {
        for (const inputMethod of ['none', 'text', 'osk', 'native']) {
            const { service } = fixture({ inputMethod, iosTouchpadDefaultVersion: 1 }).load(device);
            assert.equal(service.preferences.inputMethod, inputMethod);
            assert.equal(service.preferences.emulateAbsoluteMouse, false);
        }
        for (const emulateAbsoluteMouse of [true, false]) {
            const { service } = fixture({ emulateAbsoluteMouse, iosTouchpadDefaultVersion: 1 }).load(device);
            assert.equal(service.preferences.inputMethod, 'native');
            assert.equal(service.preferences.emulateAbsoluteMouse, emulateAbsoluteMouse);
        }
    }
});

test('legacy iOS absolute defaults migrate once without changing keyboard or unrelated settings', () => {
    const stored = { inputMethod: 'none', emulateAbsoluteMouse: true,
        language: 'nb', timezone: 'Europe/Oslo', numberOfRecentConnections: 9 };
    const storage = fixture(stored);
    const { service } = storage.load(devices[0]);
    assert.equal(service.preferences.inputMethod, 'none');
    assert.equal(service.preferences.emulateAbsoluteMouse, false);
    assert.equal(service.preferences.language, 'nb');
    assert.equal(service.preferences.timezone, stored.timezone);
    assert.equal(service.preferences.numberOfRecentConnections, stored.numberOfRecentConnections);
    assert.equal(storage.saves.length, 1);
    assert.equal(storage.stored.iosTouchpadDefaultVersion, 1);
    assert.equal(storage.load(devices[0]).service.preferences.emulateAbsoluteMouse, false);
    assert.equal(storage.saves.length, 1, 'reload must not run the migration again');
});

test('unrelated saved preferences do not suppress missing iOS defaults or change video/language settings', () => {
    const { service } = fixture({ language: 'pl', timezone: 'UTC', experimentalVideoMode: 'avc444',
        showRecentConnections: false, numberOfRecentConnections: 12 }).load(devices[1]);
    assert.equal(service.preferences.inputMethod, 'native');
    assert.equal(service.preferences.emulateAbsoluteMouse, false);
    assert.equal(service.preferences.language, 'pl');
    assert.equal(service.preferences.timezone, 'UTC');
    assert.equal(service.preferences.experimentalVideoMode, 'avc444');
    assert.equal(service.preferences.experimentalAvc420, false);
    assert.equal(service.preferences.showRecentConnections, false);
    assert.equal(service.preferences.numberOfRecentConnections, 12);
    const fresh = fixture().load({ ...devices[0], language: 'en-GB' }).service;
    assert.equal(fresh.preferences.language, 'en_GB');
    assert.equal(fresh.preferences.timezone, 'Europe/Oslo');
    assert.equal(fresh.preferences.experimentalVideoMode, null);
});

test('explicit iOS choices persist across save/reload and are not reset by fresh device detection', () => {
    const storage = fixture();
    const first = storage.load(devices[0]).service;
    first.preferences.inputMethod = 'text';
    first.preferences.emulateAbsoluteMouse = true;
    first.save();
    const next = storage.load(devices[3]).service;
    assert.equal(next.preferences.inputMethod, 'text');
    assert.equal(next.preferences.emulateAbsoluteMouse, true);
    assert.equal(storage.saves.length, 2);
});

test('automatic navigation/logout/unload persistence retains generated iOS defaults without overriding explicit changes', () => {
    const storage = fixture();
    const session = storage.load(devices[0]);
    session.root.$broadcast('$routeChangeSuccess');
    assert.equal(storage.stored.inputMethod, 'native');
    assert.equal(storage.stored.emulateAbsoluteMouse, false);
    session.service.preferences.inputMethod = 'none';
    session.root.$broadcast('guacLogout');
    session.service.preferences.emulateAbsoluteMouse = true;
    session.unload();
    const restored = storage.load(devices[1]).service;
    assert.equal(restored.preferences.inputMethod, 'none');
    assert.equal(restored.preferences.emulateAbsoluteMouse, true);
    assert.equal(storage.saves.length, 4);
});

test('existing relative mouse settings acquire the marker once and future markers are never downgraded', () => {
    const storage = fixture({ inputMethod: 'native', emulateAbsoluteMouse: false });
    assert.equal(storage.load(devices[0]).service.preferences.emulateAbsoluteMouse, false);
    assert.equal(storage.stored.iosTouchpadDefaultVersion, 1);
    storage.load(devices[1]);
    assert.equal(storage.saves.length, 1);

    const future = fixture({ emulateAbsoluteMouse: true, iosTouchpadDefaultVersion: 2 });
    const current = future.load(devices[0]).service;
    assert.equal(current.preferences.emulateAbsoluteMouse, true);
    assert.equal(current.preferences.iosTouchpadDefaultVersion, 2);
    assert.equal(future.saves.length, 0);
});
