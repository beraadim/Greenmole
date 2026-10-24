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
const { preferenceFixture, clientControllerFixture } = require('./helpers/preference-fixtures');

test('Auto resolves platform without inferring text layout from language', () => {
    const cases = [
        [{ platform: 'Win32', language: 'nb-NO' }, 'windows'],
        [{ platform: 'Linux x86_64', language: 'de-DE' }, 'windows'],
        [{ platform: 'MacIntel', language: 'en-US' }, 'mac'],
        [{ userAgent: 'iPhone', platform: 'iPhone', language: 'fr-FR' }, 'mac'],
        [{ platform: 'MacIntel', maxTouchPoints: 5, language: 'nb-NO' }, 'mac'],
        [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', language: 'ja-JP' }, 'mac'],
        [{}, 'windows']
    ];
    for (const [navigator, expected] of cases) {
        const { service } = preferenceFixture().load(navigator);
        assert.equal(service.preferences.keyboardMode, 'auto');
        assert.equal(service.getResolvedKeyboardMode(), expected);
    }
});

test('Explicit preferences survive save/reload and platform changes', () => {
    for (const mode of ['windows', 'mac', 'physical']) {
        const store = preferenceFixture();
        const { service } = store.load({ platform: 'Win32' });
        assert.equal(service.setKeyboardMode(mode), true);
        assert.equal(store.stored.keyboardMode, mode);
        assert.equal(store.load({ platform: 'MacIntel' }).service.getResolvedKeyboardMode(), mode);
    }
});

test('Invalid stored modes normalize and invalid choices cannot be saved', () => {
    for (const invalid of [null, '', 'MAC', 'nb-NO', '<script>', {}, 3]) {
        const store = preferenceFixture({ keyboardMode: invalid });
        const { service } = store.load({ platform: 'MacIntel' });
        assert.equal(service.preferences.keyboardMode, 'auto');
        assert.equal(service.getResolvedKeyboardMode(), 'mac');
        const saves = store.saves.length;
        assert.equal(service.setKeyboardMode(invalid), false);
        assert.equal(store.saves.length, saves);
        assert.equal(service.preferences.keyboardMode, 'auto');
    }
});

test('Connection menu saves a next-session choice without reconnecting', () => {
    const store = preferenceFixture();
    const { service } = store.load({ platform: 'Win32' });
    const { scope } = clientControllerFixture(service);
    assert.equal(scope.menu.keyboardMode, 'auto');
    scope.menu.keyboardMode = 'mac';
    scope.setKeyboardMode();
    assert.equal(store.stored.keyboardMode, 'mac');
    scope.menu.keyboardMode = 'auto';
    scope.setKeyboardMode();
    assert.equal(service.getResolvedKeyboardMode(), 'windows');
});
