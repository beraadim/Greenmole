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

// Modified for Greenmole by its maintainers.

const assert = require('node:assert/strict');
const test = require('node:test');
const { directiveFixture } = require('./helpers/client-fixtures');

const finger = (identifier, x, y) => ({ identifier, clientX: x, clientY: y });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8,
    `expected ${actual} to equal ${expected}`);

function fixture({ scale = 1, panning = true, native = true, absolute = false,
        multiTouchSupport = 0, blocked = false, left = 80, top = 60 } = {}) {
    const keyboard = { enabled: native, panning };
    const view = directiveFixture({ nativeKeyboard: keyboard, blocked });
    const display = view.displays[0];
    const properties = view.scope.client.clientProperties;
    Object.assign(properties, { scale, minScale: 0.2, maxScale: 3, autoFit: true });
    display.scale(scale);
    Object.assign(view.main, { clientWidth: 390, offsetWidth: 390, clientHeight: 300, offsetHeight: 300 });

    // Model the real scaled .display, its centering at small zoom levels, and
    // the browser's synchronous scroll clamping when content shrinks. DOMRects
    // include both the containing view's offset and its current scroll.
    const width = () => display.getWidth() * display.getScale();
    const height = () => display.getHeight() * display.getScale();
    const centerX = () => Math.max(0, (view.main.clientWidth - width()) / 2);
    const centerY = () => Math.max(0, (view.main.clientHeight - height()) / 2);
    let scrollLeft = 0;
    let scrollTop = 0;
    Object.defineProperties(view.main, {
        scrollWidth: { get: () => Math.max(view.main.clientWidth, width()) },
        scrollHeight: { get: () => Math.max(view.main.clientHeight, height()) },
        scrollLeft: {
            get: () => Math.max(0, Math.min(scrollLeft, view.main.scrollWidth - view.main.clientWidth)),
            set: value => { scrollLeft = Math.max(0, Math.min(value, view.main.scrollWidth - view.main.clientWidth)); }
        },
        scrollTop: {
            get: () => Math.max(0, Math.min(scrollTop, view.main.scrollHeight - view.main.clientHeight)),
            set: value => { scrollTop = Math.max(0, Math.min(value, view.main.scrollHeight - view.main.clientHeight)); }
        }
    });
    Object.defineProperties(view.container, {
        offsetLeft: { get: centerX }, offsetTop: { get: centerY }
    });
    view.main.getBoundingClientRect = () => ({ left: 30, top: 40, width: 390, height: 300 });
    view.container.getBoundingClientRect = () => ({
        left: 30 + centerX() - view.main.scrollLeft,
        top: 40 + centerY() - view.main.scrollTop, width: width(), height: height()
    });
    view.main.scrollLeft = properties.scrollLeft = left;
    view.main.scrollTop = properties.scrollTop = top;
    view.scope.emulateAbsoluteMouse = absolute;
    view.scope.client.multiTouchSupport = multiTouchSupport;
    view.configureTouch();

    const pointer = (device, type, x, y, flags = {}) => {
        const event = { type, state: { x, y, ...flags }, stopPropagation() {}, preventDefault() {} };
        device.emit(event);
        return event;
    };
    return Object.assign(view, {
        display, properties, keyboard, pointer,
        remotePoint(x, y) {
            const rect = view.container.getBoundingClientRect();
            return [(x - rect.left) / display.getScale(), (y - rect.top) / display.getScale()];
        },
        touchEvent(type, touches) {
            const event = {
                touches, defaultPrevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopImmediatePropagation() { this.stopped = true; }
            };
            for (const [callback, options] of view.mainEvents.get(type) || []) {
                if (options?.capture) callback(event);
                if (event.stopped) break;
            }
            // Only events which survive capture reach the real remote routing
            // handlers installed by guacClient. No browser or tunnel is opened.
            if (!event.stopped) {
                if (absolute && multiTouchSupport)
                    view.touch.emit({ type, state: { x: 100, y: 100, force: 1 }, preventDefault() {} });
                else
                    pointer(absolute ? view.touchscreen : view.touchpad,
                        type === 'touchstart' ? 'mousedown' : type === 'touchend' ? 'mouseup' : 'mousemove',
                        100, 100, { left: type !== 'touchend' });
            }
            return event;
        }
    });
}

test('native Pan pinches locally despite relative/server-touch modes and the remaining finger pans both axes', () => {
    for (const options of [{ absolute: false }, { absolute: false, multiTouchSupport: 10 },
        { absolute: true, multiTouchSupport: 10 }]) {
        const view = fixture(options);
        const before = view.remotePoint(200, 140);
        assert.equal(view.touchEvent('touchstart', [finger(1, 150, 140), finger(2, 250, 140)]).stopped, true);
        view.touchEvent('touchmove', [finger(2, 300, 140), finger(1, 100, 140)]);
        assert.equal(view.display.getScale(), 2);
        assert.equal(view.properties.scale, 2);
        assert.equal(view.properties.autoFit, false);
        assert.equal(view.main.style.overflow, 'auto');
        close(view.main.scrollLeft, 330);
        close(view.main.scrollTop, 220);
        view.remotePoint(200, 140).forEach((value, axis) => close(value, before[axis]));
        assert.equal(view.properties.scrollLeft, view.main.scrollLeft);
        assert.equal(view.properties.scrollTop, view.main.scrollTop);

        view.touchEvent('touchend', [finger(1, 100, 140)]);
        view.touchEvent('touchmove', [finger(1, 70, 100)]);
        assert.equal(view.main.scrollLeft, 360);
        assert.equal(view.main.scrollTop, 260);
        view.touchEvent('touchend', []);
        assert.deepEqual(view.sent, [], 'local navigation must send neither touch, mouse nor resize');
        assert.deepEqual([view.display.getWidth(), view.display.getHeight()], [1920, 1080]);
        view.scope.$broadcast('$destroy');
    }
});

test('pinching a centered desktop into overflow keeps the remote point under the fingers', () => {
    const view = fixture({ scale: 0.2, left: 0, top: 0 });
    assert.deepEqual(view.container.getBoundingClientRect(), { left: 33, top: 82, width: 384, height: 216 });
    const before = view.remotePoint(220, 170);
    view.touchEvent('touchstart', [finger(1, 200, 170), finger(2, 240, 170)]);
    view.touchEvent('touchmove', [finger(1, 180, 170), finger(2, 260, 170)]);
    close(view.display.getScale(), 0.4);
    close(view.main.scrollLeft, 184);
    close(view.main.scrollTop, 46);
    view.remotePoint(220, 170).forEach((value, axis) => close(value, before[axis]));
    assert.deepEqual(view.sent, []);
});

test('local zoom honors minimum/maximum limits and browser scroll bounds', () => {
    const view = fixture({ scale: 2.5 });
    const before = view.remotePoint(200, 140);
    view.touchEvent('touchstart', [finger(1, 150, 140), finger(2, 250, 140)]);
    view.touchEvent('touchmove', [finger(1, 0, 140), finger(2, 400, 140)]);
    assert.equal(view.display.getScale(), 3);
    view.remotePoint(200, 140).forEach((value, axis) => close(value, before[axis]));
    view.touchEvent('touchmove', [finger(1, 199.5, 140), finger(2, 200.5, 140)]);
    assert.equal(view.display.getScale(), 0.2);
    assert.equal(view.properties.scale, 0.2);
    assert.deepEqual([view.main.scrollLeft, view.main.scrollTop], [0, 0]);
    assert.deepEqual([view.properties.scrollLeft, view.properties.scrollTop], [0, 0]);
    assert.deepEqual(view.sent, []);
});

test('Pan off confines the fractional-scale pointer and its trackpad accumulator without scrolling or reversal lag', () => {
    const view = fixture({ scale: 1.25, panning: false, left: 80.4, top: 60.4 });
    const event = view.pointer(view.touchpad, 'mousemove', 50000, 50000);
    assert.deepEqual(view.sent[0].slice(2, 4), [376, 288]);
    assert.deepEqual([event.state.x, event.state.y], [470, 360]);
    assert.deepEqual([view.touchpad.currentState.x, view.touchpad.currentState.y], [470, 360]);
    view.pointer(view.touchpad, 'mousemove', view.touchpad.currentState.x - 1.25,
        view.touchpad.currentState.y - 1.25);
    assert.deepEqual(view.sent[1].slice(2, 4), [375, 287]);
    view.pointer(view.touchpad, 'mousemove', -50000, -50000);
    assert.deepEqual(view.sent[2].slice(2, 4), [65, 49]);
    view.pointer(view.touchpad, 'mousemove', view.touchpad.currentState.x + 1.25,
        view.touchpad.currentState.y + 1.25);
    assert.deepEqual(view.sent[3].slice(2, 4), [66, 50]);
    assert.deepEqual([view.main.scrollLeft, view.main.scrollTop], [80.4, 60.4]);
    for (const row of view.sent) {
        assert.ok(Number.isInteger(row[2]) && Number.isInteger(row[3]));
        assert.ok(row[2] >= 65 && row[2] <= 376 && row[3] >= 49 && row[3] <= 288);
    }
});

test('contained drag/release/wheel/key input retains clipboard order and snapshots coordinates before zoom changes', () => {
    const view = fixture({ scale: 1.25, panning: false, blocked: true, left: 80.4, top: 60.4 });
    view.pointer(view.touchpad, 'mousedown', 50000, 50000, { left: true });
    view.pointer(view.touchpad, 'mousemove', 0, 0, { left: true });
    view.pointer(view.touchpad, 'mousemove', 250, 125, { left: true });
    view.pointer(view.touchpad, 'mouseup', 250, 125);
    view.pointer(view.touchpad, 'mousedown', 250, 125, { up: true });
    view.pointer(view.touchpad, 'mouseup', 250, 125);
    view.scope.$broadcast('guacSyntheticKeydown', 0x61);
    view.pointer(view.touchpad, 'mousemove', 300, 150);
    view.scope.$broadcast('guacSyntheticKeyup', 0x61);
    assert.deepEqual(view.sent, []);
    view.properties.scale = 2;
    view.watches.get('client.clientProperties.scale')(2);
    assert.deepEqual(view.sent, [], 'rebasing after zoom must not enqueue remote input');
    view.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(view.sent, [
        ['first', 'mouse', 376, 288, true, false, false, false, false],
        ['first', 'mouse', 65, 49, true, false, false, false, false],
        ['first', 'mouse', 200, 100, true, false, false, false, false],
        ['first', 'mouse', 200, 100, false, false, false, false, false],
        ['first', 'mouse', 200, 100, false, false, false, true, false],
        ['first', 'mouse', 200, 100, false, false, false, false, false],
        ['first', 'key', 1, 0x61],
        ['first', 'mouse', 240, 120, false, false, false, false, false],
        ['first', 'key', 0, 0x61]
    ]);
    assert.deepEqual([view.main.scrollLeft, view.main.scrollTop], [80.4, 60.4]);
});

test('flushing pre-zoom input preserves its remote snapshot while keeping local cursor feedback inside the current view', () => {
    const view = fixture({ scale: 1.25, panning: false, blocked: true, left: 80.4, top: 60.4 });
    const client = view.scope.client.client;
    const recordMouseState = client.sendMouseState.bind(client);
    // Guacamole.Client.sendMouseState() also updates its display cursor. Model
    // that side effect so a deferred send can undo the scale watch's rebase.
    client.sendMouseState = state => {
        view.display.moveCursor(Math.floor(state.x), Math.floor(state.y));
        recordMouseState(state);
    };

    view.pointer(view.touchpad, 'mousemove', 50000, 50000);
    assert.deepEqual([view.display.cursorX, view.display.cursorY], [376, 288]);
    assert.deepEqual(view.sent, []);
    view.properties.scale = 2;
    view.watches.get('client.clientProperties.scale')(2);
    assert.deepEqual([view.display.cursorX, view.display.cursorY], [235, 180]);
    assert.deepEqual([view.touchpad.currentState.x, view.touchpad.currentState.y], [470, 360]);
    assert.deepEqual(view.sent, []);

    view.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(view.sent, [
        ['first', 'mouse', 376, 288, false, false, false, false, false]
    ], 'local feedback correction must not alter or append remote input');
    assert.deepEqual([view.display.cursorX, view.display.cursorY], [235, 180]);
    assert.deepEqual([view.touchpad.currentState.x, view.touchpad.currentState.y], [470, 360]);
    assert.deepEqual([view.main.scrollLeft, view.main.scrollTop], [80.4, 60.4]);
});

test('the scale watch silently rebases an outside cursor into the visible view and prepares immediate reverse input', () => {
    const view = fixture({ scale: 1.25, panning: false, left: 80.4, top: 60.4 });
    view.display.cursorX = 1800;
    view.display.cursorY = 1000;
    view.touchpad.currentState.x = 50000;
    view.touchpad.currentState.y = 50000;
    view.properties.scale = 2;
    view.watches.get('client.clientProperties.scale')(2);
    assert.deepEqual([view.display.cursorX, view.display.cursorY], [235, 180]);
    assert.deepEqual([view.touchpad.currentState.x, view.touchpad.currentState.y], [470, 360]);
    assert.deepEqual(view.sent, []);
    view.pointer(view.touchpad, 'mousemove', view.touchpad.currentState.x - 2,
        view.touchpad.currentState.y - 2);
    assert.deepEqual(view.sent[0].slice(2, 4), [234, 179]);
    assert.deepEqual([view.main.scrollLeft, view.main.scrollTop], [80.4, 60.4]);
});

test('native keyboard suppresses bubbling legacy drag/pinch navigation in either Pan state', () => {
    for (const panning of [false, true]) {
        const view = fixture({ scale: 1.25, panning, absolute: true });
        assert.equal(view.scope.clientDrag(true, 0, 0, 100, 100, 10, 15), false);
        assert.equal(view.scope.clientPinch(true, 100, 200, 200, 140), false);
        assert.deepEqual([view.properties.scale, view.properties.scrollLeft, view.properties.scrollTop], [1.25, 80, 60]);
        assert.deepEqual([view.main.scrollLeft, view.main.scrollTop], [80, 60]);
        assert.deepEqual(view.sent, []);
    }
});

test('non-native mouse routing, pointer-follow scrolling and absolute-mode legacy gestures remain unchanged', () => {
    const relative = fixture({ native: false, panning: false, scale: 1.25 });
    relative.pointer(relative.mouse, 'mousemove', 50000, 50000);
    assert.deepEqual(relative.sent[0].slice(2, 4), [40000, 40000]);
    assert.deepEqual([relative.main.scrollLeft, relative.main.scrollTop], [80, 60]);
    relative.pointer(relative.touchpad, 'mousemove', 1000, 900);
    assert.deepEqual(relative.sent[1].slice(2, 4), [800, 720]);
    assert.deepEqual([relative.main.scrollLeft, relative.main.scrollTop], [610, 600]);
    relative.scope.clientPinch(true, 100, 200, 200, 140);
    assert.equal(relative.properties.scale, 1.25);

    const absolute = fixture({ native: false, panning: false, scale: 1.25, absolute: true });
    absolute.scope.clientDrag(true, 0, 0, 100, 100, 10, 15);
    assert.deepEqual([absolute.properties.scrollLeft, absolute.properties.scrollTop], [70, 45]);
    absolute.properties.scrollLeft = 80;
    absolute.properties.scrollTop = 60;
    absolute.scope.clientPinch(true, 100, 100, 200, 140);
    absolute.scope.clientPinch(true, 100, 200, 200, 140);
    assert.deepEqual([absolute.properties.scale, absolute.properties.scrollLeft, absolute.properties.scrollTop], [2.5, 360, 260]);
});

test('destroy removes capture and configured relative/absolute/touch handlers instead of retaining a dead view', () => {
    for (const options of [{ absolute: false }, { absolute: true }, { absolute: true, multiTouchSupport: 10 }]) {
        const view = fixture(options);
        view.scope.$broadcast('$destroy');
        for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
            assert.equal(view.mainEvents.get(name).size, 0, name + ' capture listener');
        for (const [deviceName, device] of [['mouse', view.mouse], ['trackpad', view.touchpad],
            ['touchscreen', view.touchscreen], ['native touch', view.touch]]) {
            for (const [name, listeners] of device.active)
                assert.equal(listeners.size, 0, deviceName + ' ' + name);
        }
        assert.deepEqual(view.sent, []);
    }
});
