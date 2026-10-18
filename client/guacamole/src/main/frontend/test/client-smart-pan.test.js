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
const { sources, directiveFixture, mouseEvent, fakeClock } = require('./helpers/client-fixtures');

const ClientSmartPan = sources(['client/types/ClientSmartPan.js'])
    .factories.ClientSmartPan();

function fixture() {
    const listeners = new Map();
    const scrolls = [];
    const element = {
        clientWidth: 1000, clientHeight: 400,
        scrollWidth: 2000, scrollHeight: 1044,
        scrollLeft: 0, scrollTop: 0,
        addEventListener(name, callback) { listeners.set(name, callback); },
        removeEventListener(name, callback) {
            assert.equal(listeners.get(name), callback);
            listeners.delete(name);
        }
    };
    const pan = new ClientSmartPan(element, (left, top) => scrolls.push([left, top]));
    const geometry = { width: 1000, height: 400, bottomInset: 44, scale: 1, left: 0, top: 0 };
    pan.setState(true, true, true);
    return { element, pan, geometry, listeners, scrolls,
        update(values = {}) { Object.assign(geometry, values); pan.update(geometry); },
        scrolled() { listeners.get('scroll')(); } };
}

test('smart pan reveals the last click above the keyboard toolbar without centering or following later hover', () => {
    const f = fixture();
    f.pan.recordPointer(500, 700, true);
    f.pan.recordPointer(500, 50, false);
    f.update();
    assert.deepEqual(f.scrolls, [[0, 376]]);
    f.pan.recordPointer(500, 900, true);
    f.update();
    assert.deepEqual(f.scrolls, [[0, 376]], 'unchanged geometry must not keep following input');
});

test('pointer fallback is used only when known and no primary click has been recorded', () => {
    const f = fixture();
    f.update();
    assert.deepEqual(f.scrolls, []);
    f.pan.recordPointer(NaN, 20, true);
    f.pan.recordPointer(-1, 700, true);
    f.pan.recordPointer(500, 700, false);
    f.update({ height: 399 });
    assert.deepEqual(f.scrolls, [[0, 377]]);
});

test('smart pan follows opening geometry only and accounts for remote scale and display offsets', () => {
    const f = fixture();
    f.pan.recordPointer(1000, 1400, true);
    f.update({ height: 600, scale: 0.5, left: 10, top: 20 });
    assert.deepEqual(f.scrolls, [[0, 196]]);
    f.update({ height: 500 });
    f.update({ height: 400 });
    assert.deepEqual(f.scrolls, [[0, 196], [0, 296], [0, 396]]);
    assert.equal(f.geometry.scale, 0.5);
});

test('manual zoom and desktop edges use CSS pixels and clamp to real scrollable content', () => {
    const f = fixture();
    f.pan.recordPointer(500, 350, true);
    f.update({ scale: 2 });
    assert.deepEqual(f.scrolls, [[32, 376]]);

    f.pan.recordPointer(2000, 2000, true);
    f.update({ height: 399 });
    assert.deepEqual(f.scrolls.at(-1), [1000, 644]);
    f.pan.recordPointer(0, 0, true);
    f.update({ height: 398 });
    assert.deepEqual(f.scrolls.at(-1), [0, 0]);
});

test('manual adjustment survives further keyboard animation and Pan off/on until a fresh focus opening', () => {
    const f = fixture();
    f.pan.recordPointer(500, 700, true);
    f.update();
    f.pan.markManual();
    f.element.scrollTop = 120;
    f.update({ height: 300 });
    f.pan.setState(true, true, false);
    f.pan.setState(true, true, true);
    f.update({ height: 250 });
    assert.equal(f.element.scrollTop, 120);

    f.pan.setState(true, false, true);
    f.pan.setState(true, true, true);
    f.update();
    assert.equal(f.element.scrollTop, 526);
});

test('own scroll notifications are ignored and a user scrollbar movement disables further assistance', () => {
    const f = fixture();
    f.pan.recordPointer(500, 700, true);
    f.update();
    f.scrolled();
    f.update({ height: 350 });
    assert.equal(f.element.scrollTop, 426);
    f.element.scrollTop = 100;
    f.scrolled();
    f.update({ height: 300 });
    assert.equal(f.element.scrollTop, 100);
});

test('Pan can be enabled after keyboard opening, while clear and disposal discard session hints', () => {
    const f = fixture();
    f.pan.recordPointer(500, 700, true);
    f.pan.setState(true, true, false);
    f.update();
    assert.deepEqual(f.scrolls, []);
    f.pan.setState(true, true, true);
    f.update();
    assert.deepEqual(f.scrolls, [[0, 376]]);
    f.pan.clear();
    f.pan.setState(true, true, true);
    f.update({ height: 300 });
    assert.deepEqual(f.scrolls, [[0, 376]]);
    f.pan.dispose();
    assert.equal(f.listeners.size, 0);
    f.pan.recordPointer(500, 900, true);
    f.pan.setState(true, true, true);
    f.update({ height: 200 });
    assert.deepEqual(f.scrolls, [[0, 376]]);
});

function clientFixture({ keyboard = { enabled: true, panning: false, focused: false } } = {}) {
    let state = { preserveLayout: true, keyboardActive: false, toolbarHeight: 44 };
    let publish;
    const viewportService = {
        getRemoteSize(width, height, rows, previous) { return previous || { width, height }; },
        subscribe(callback) { publish = callback; callback(state); return () => {}; }
    };
    const client = directiveFixture({ nativeKeyboard: keyboard, viewportService, density: 2 });
    Object.assign(client.main, {
        offsetWidth: 1024, offsetHeight: 724,
        clientWidth: 1024, clientHeight: 724,
        scrollWidth: 1024, scrollHeight: 724
    });
    client.displays[0].getWidth = () => 2048;
    client.displays[0].getHeight = () => 1448;
    client.displays[0].scale(0.5);
    client.scope.mainElementResized();
    return Object.assign(client, { keyboard,
        publish(values) { state = { ...state, ...values }; publish(state); },
        open(height = 400) {
            keyboard.focused = true;
            keyboard.panning = true;
            Object.assign(client.main, { offsetHeight: height, clientHeight: height });
            this.publish({ keyboardActive: true, keyboardFocused: true });
        }
    });
}

test('actual directive records remote click coordinates once at DPR 2 and reveals them when native keyboard opens', () => {
    const f = clientFixture();
    f.mouse.emit({ ...mouseEvent('mousedown', 500, { left: true }), state: { x: 500, y: 700, left: true } });
    f.mouse.emit({ ...mouseEvent('mouseup', 500), state: { x: 500, y: 700, left: false } });
    f.mouse.emit({ ...mouseEvent('mousemove', 200), state: { x: 200, y: 100 } });
    f.open();
    assert.equal(f.main.scrollTop, 324);
    assert.equal(f.scope.client.clientProperties.scrollTop, 324);
    assert.equal(f.displays[0].getScale(), 0.5);
    assert.deepEqual(f.sent[0].slice(2, 4), [1000, 1400]);
    assert.deepEqual(f.connections, [['first', 1024, 724]]);
});

test('actual directive only assists the focused tile and does not subtract the in-flow controls twice', () => {
    const f = clientFixture();
    f.mouse.emit({ ...mouseEvent('mousedown', 500, { left: true }), state: { x: 500, y: 350, left: true } });
    f.scope.client.clientProperties.focused = false;
    f.open();
    assert.equal(f.main.scrollTop, 0);

    f.scope.client.clientProperties.focused = true;
    f.watches.get('client.clientProperties.focused')();
    assert.equal(f.main.scrollTop, 0, '350px anchor already fits the 400px unobstructed client');
    Object.assign(f.main, { offsetHeight: 350, clientHeight: 350 });
    f.scope.mainElementResized();
    assert.equal(f.main.scrollTop, 32);
});

test('actual primary touch input supplies an anchor and replacing the managed client clears it', () => {
    const f = clientFixture();
    f.scope.client.multiTouchSupport = 2;
    f.scope.emulateAbsoluteMouse = true;
    f.configureTouch();
    f.touch.emit({ type: 'touchmove', state: { id: 0, x: 500, y: 700, force: 1 }, preventDefault() {} });
    f.touch.emit({ type: 'touchmove', state: { id: 1, x: 100, y: 100, force: 1 }, preventDefault() {} });
    f.open();
    assert.equal(f.main.scrollTop, 324);
    f.main.scrollTop = 0;
    f.attach(f.managed('second'));
    f.publish({ toolbarHeight: 45 });
    assert.equal(f.main.scrollTop, 0);
});

test('beginning a manual Pan gesture at an edge still prevents the remaining keyboard animation from moving the view', () => {
    const f = clientFixture();
    f.mouse.emit({ ...mouseEvent('mousedown', 500, { left: true }), state: { x: 500, y: 600, left: true } });
    f.open(724);
    assert.equal(f.main.scrollTop, 0);
    const touch = { touches: [{ identifier: 0, clientX: 100, clientY: 200 }],
        preventDefault() {}, stopImmediatePropagation() {} };
    for (const [callback, options] of f.mainEvents.get('touchstart'))
        if (options.capture) callback(touch);
    Object.assign(f.main, { offsetHeight: 400, clientHeight: 400 });
    f.publish({ toolbarHeight: 45 });
    assert.equal(f.main.scrollTop, 0);
});

test('actual viewport service publishes a same-geometry Show blur/refocus and rearms smart pan after manual adjustment', () => {
    const loaded = sources(['textInput/services/guacNativeKeyboard.js',
        'client/services/guacViewportService.js']);
    const clock = fakeClock();
    const visualClock = fakeClock();
    const window = Object.assign(clock.window, {
        innerWidth: 1024, innerHeight: 768,
        visualViewport: Object.assign(visualClock.window, { width: 1024, height: 444, scale: 1 })
    });
    const native = loaded.factories.guacNativeKeyboard(window);
    native.setEnabled(true);
    native.setToolbarHeight(44);
    const f = clientFixture({ keyboard: native });
    Object.assign(f.main, { offsetHeight: 400, clientHeight: 400 });
    f.mouse.emit({ ...mouseEvent('mousedown', 500, { left: true }), state: { x: 500, y: 700, left: true } });
    const viewport = loaded.factories.guacViewportService(window, native);
    const stop = viewport.subscribe(state => f.publish(state));
    native.setPanning(true);
    native.setFocused(true);
    assert.equal(f.main.scrollTop, 324);

    f.main.scrollTop = 120;
    for (const [callback] of f.mainEvents.get('scroll')) callback();
    f.scope.mainElementResized();
    assert.equal(f.main.scrollTop, 120);

    // Show deliberately blurs/refocuses the mounted editor even if iOS left
    // it focused after hiding the software keyboard. Geometry is unchanged.
    native.setFocused(false);
    native.setFocused(true);
    assert.equal(f.main.scrollTop, 324);
    stop();
    f.scope.$broadcast('$destroy');
});
