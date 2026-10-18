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
const { directiveFixture, mouseEvent } = require('./helpers/client-fixtures');

const iPad = { platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh)' };

test('legacy saved iOS absolute mode migrates through the actual page menu to relative input routing', () => {
    const storage = preferenceFixture({ inputMethod: 'native', emulateAbsoluteMouse: true,
        language: 'pl', experimentalVideoMode: 'avc444' });
    const preferences = storage.load(iPad).service;
    const page = clientControllerFixture(preferences);
    assert.equal(page.scope.menu.emulateAbsoluteMouse, false);
    assert.equal(page.scope.menu.inputMethod, 'native');
    page.watches.get('menu.inputMethod')(page.scope.menu.inputMethod);
    assert.equal(page.keyboard.enabled, true);
    assert.equal(storage.stored.iosTouchpadDefaultVersion, 1);
    assert.equal(storage.saves.length, 1, 'initial controller binding must not overwrite the migration');

    // Feed the actual page menu value into the production client directive,
    // including a server that advertises native touch support.
    const view = directiveFixture();
    view.scope.client.multiTouchSupport = 10;
    view.scope.emulateAbsoluteMouse = page.scope.menu.emulateAbsoluteMouse;
    view.configureTouch();
    view.touch.emit({ type: 'touchstart', state: { id: 0, x: 100, y: 100, force: 1 }, preventDefault() {} });
    assert.deepEqual(view.sent, []);
    view.touchpad.emit(mouseEvent('mousedown', 100, { left: true }));
    assert.deepEqual(view.sent.map(row => row.slice(0, 5)), [['first', 'mouse', 50, 10, true]]);
});

test('explicit page mouse choices save immediately, close the menu and survive reload after migration', () => {
    const storage = preferenceFixture({ inputMethod: 'native', emulateAbsoluteMouse: true,
        language: 'pl', experimentalVideoMode: 'avc444' });
    const preferences = storage.load(iPad).service;
    const page = clientControllerFixture(preferences);
    page.scope.menu.shown = true;
    page.scope.menu.emulateAbsoluteMouse = true;
    page.scope.setMouseMode();
    assert.equal(page.scope.menu.shown, false);
    assert.equal(storage.stored.emulateAbsoluteMouse, true);
    assert.equal(storage.stored.iosTouchpadDefaultVersion, 1);
    assert.equal(storage.stored.inputMethod, 'native');
    assert.equal(storage.stored.language, 'pl');
    assert.equal(storage.stored.experimentalVideoMode, 'avc444');
    assert.equal(storage.saves.length, 2);

    const reloaded = clientControllerFixture(storage.load(iPad).service);
    assert.equal(reloaded.scope.menu.emulateAbsoluteMouse, true);
    assert.equal(storage.saves.length, 2, 'versioned absolute selection must not migrate on reload');
    reloaded.scope.menu.emulateAbsoluteMouse = false;
    reloaded.scope.setMouseMode();
    assert.equal(storage.stored.emulateAbsoluteMouse, false);
    assert.equal(clientControllerFixture(storage.load(iPad).service).scope.menu.emulateAbsoluteMouse, false);
});

test('non-iOS saved mouse preferences avoid migration and explicit page selections still persist', () => {
    const storage = preferenceFixture({ inputMethod: 'none', emulateAbsoluteMouse: true });
    const preferences = storage.load({ platform: 'Win32', maxTouchPoints: 10 }).service;
    const page = clientControllerFixture(preferences);
    assert.equal(page.scope.menu.emulateAbsoluteMouse, true);
    assert.equal(page.scope.menu.inputMethod, 'none');
    assert.equal(storage.saves.length, 0);
    assert.equal('iosTouchpadDefaultVersion' in preferences.preferences, false);
    page.scope.menu.emulateAbsoluteMouse = false;
    page.scope.setMouseMode();
    assert.equal(storage.stored.emulateAbsoluteMouse, false);
    assert.equal('iosTouchpadDefaultVersion' in storage.stored, false);
    assert.equal(storage.saves.length, 1);
});
