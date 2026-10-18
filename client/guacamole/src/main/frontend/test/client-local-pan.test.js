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
const { sources, directiveFixture, mouseEvent } = require('./helpers/client-fixtures');

const ClientLocalPan = sources(['client/types/ClientLocalPan.js'])
    .factories.ClientLocalPan();

const finger = (identifier, x, y) => ({ identifier, clientX: x, clientY: y });

function fixture() {
    const listeners = new Map();
    const scrolls = [];
    const remote = [];
    let enabled = true;
    const element = {
        scrollLeft: 100, scrollTop: 200,
        scrollWidth: 1200, scrollHeight: 1600,
        clientWidth: 1000, clientHeight: 600,
        addEventListener(name, callback, options) {
            assert.equal(options.capture, true);
            assert.equal(options.passive, false);
            listeners.set(name, callback);
        },
        removeEventListener(name, callback, options) {
            assert.equal(listeners.get(name), callback);
            assert.equal(options.capture, true);
            listeners.delete(name);
        }
    };
    const pan = new ClientLocalPan(element, () => enabled,
        (left, top) => scrolls.push([left, top]));
    return {
        element, pan, listeners, scrolls, remote,
        setEnabled(value) { enabled = value; },
        event(name, touches) {
            const event = {
                touches, defaultPrevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopImmediatePropagation() { this.stopped = true; }
            };
            listeners.get(name)?.(event);
            // Bubble handlers represent the real touchscreen/touchpad/native
            // touch path, all downstream of the production capture listener.
            if (!event.stopped) remote.push(name);
            return event;
        }
    };
}

test('one-finger native keyboard pan moves the local desktop in both axes without remote gestures', () => {
    const view = fixture();
    const start = view.event('touchstart', [finger(7, 150, 250)]);
    assert.equal(start.defaultPrevented, true);
    view.event('touchmove', [finger(7, 100, 100)]);
    view.event('touchmove', [finger(7, 120, 180)]);
    view.event('touchend', []);
    assert.deepEqual(view.scrolls, [[150, 350], [130, 270]]);
    assert.deepEqual(view.remote, []);
    assert.equal(view.element.scrollTop, 270);
});

test('local pan clamps desktop edges and does not accumulate repeated movement at a boundary', () => {
    const view = fixture();
    view.event('touchstart', [finger(0, 0, 0)]);
    view.event('touchmove', [finger(0, 1000, 2000)]);
    assert.deepEqual(view.scrolls, [[0, 0]]);
    view.event('touchmove', [finger(0, 2000, 3000)]);
    assert.deepEqual(view.scrolls, [[0, 0]]);
    view.event('touchmove', [finger(0, -2000, -3000)]);
    assert.deepEqual(view.scrolls, [[0, 0], [200, 1000]]);
    assert.deepEqual(view.remote, []);
});

test('disabled pan leaves remote touch and browser focus behavior unchanged', () => {
    const view = fixture();
    view.setEnabled(false);
    assert.equal(view.event('touchstart', [finger(1, 10, 10)]).defaultPrevented, false);
    view.event('touchmove', [finger(1, 30, 40)]);
    view.event('touchend', []);
    assert.deepEqual(view.remote, ['touchstart', 'touchmove', 'touchend']);
    assert.deepEqual(view.scrolls, []);
});

test('mode changes never steal an existing remote gesture or leak the end of an owned local gesture', () => {
    const view = fixture();
    view.setEnabled(false);
    view.event('touchstart', [finger(1, 10, 10)]);
    view.setEnabled(true);
    view.event('touchstart', [finger(1, 10, 10), finger(2, 40, 50)]);
    view.event('touchmove', [finger(1, 30, 40), finger(2, 60, 70)]);
    view.event('touchend', [finger(1, 30, 40)]);
    view.event('touchmove', [finger(1, 30, 40)]);
    view.event('touchend', []);
    assert.deepEqual(view.remote, ['touchstart', 'touchstart', 'touchmove', 'touchend', 'touchmove', 'touchend']);
    view.remote.length = 0;

    view.event('touchstart', [finger(2, 100, 200)]);
    view.setEnabled(false);
    view.event('touchmove', [finger(2, 100, 100)]);
    view.event('touchend', []);
    assert.deepEqual(view.scrolls, [[100, 300]]);
    assert.deepEqual(view.remote, []);
    view.event('touchstart', [finger(3, 1, 1)]);
    assert.deepEqual(view.remote, ['touchstart']);
});

test('multiple contacts never zoom the desktop or resume panning from a remaining finger', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 200)]);
    view.event('touchstart', [finger(1, 100, 200), finger(2, 200, 300)]);
    view.event('touchmove', [finger(1, 100, 100), finger(2, 200, 200)]);
    view.event('touchend', [finger(1, 100, 100)]);
    view.event('touchmove', [finger(1, 100, 20)]);
    view.event('touchend', []);
    assert.deepEqual(view.scrolls, []);
    assert.deepEqual(view.remote, []);
    view.event('touchstart', [finger(3, 100, 200)]);
    view.event('touchmove', [finger(3, 100, 100)]);
    assert.deepEqual(view.scrolls, [[100, 300]]);
});

test('a fresh single-contact gesture recovers after an unrelated contact ended outside the client', () => {
    const view = fixture();
    view.setEnabled(false);
    view.event('touchstart', [finger(1, 100, 200), finger(2, 300, 400)]);
    // Contact 1 began on the desktop, contact 2 on the toolbar. The toolbar's
    // final touchend does not bubble through the desktop capture listener.
    view.event('touchend', [finger(2, 300, 400)]);
    view.setEnabled(true);
    view.event('touchstart', [finger(3, 100, 200)]);
    view.event('touchmove', [finger(3, 100, 100)]);
    assert.deepEqual(view.scrolls, [[100, 300]]);
});

test('touch cancellation resets the next local gesture and teardown removes every capture listener', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 200)]);
    view.event('touchcancel', []);
    view.event('touchstart', [finger(2, 100, 200)]);
    view.event('touchmove', [finger(2, 100, 100)]);
    assert.deepEqual(view.scrolls, [[100, 300]]);
    view.pan.dispose();
    assert.equal(view.listeners.size, 0);
});

test('detaching a view cancels movement but retains local ownership until every touch ends', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 200)]);
    view.pan.cancel();
    view.event('touchmove', [finger(1, 100, 100)]);
    view.event('touchend', []);
    assert.deepEqual(view.scrolls, []);
    assert.deepEqual(view.remote, []);
    view.event('touchstart', [finger(2, 100, 200)]);
    view.event('touchmove', [finger(2, 100, 100)]);
    assert.deepEqual(view.scrolls, [[100, 300]]);
});

function clientFixture({ absolute, multiTouchSupport = 0 } = {}) {
    const keyboard = { enabled: true, panning: true };
    const client = directiveFixture({ nativeKeyboard: keyboard });
    client.scope.emulateAbsoluteMouse = absolute;
    client.scope.client.multiTouchSupport = multiTouchSupport;
    client.configureTouch();
    Object.assign(client.main, {
        scrollWidth: 1600, scrollHeight: 1200,
        clientWidth: 1000, clientHeight: 500
    });
    return Object.assign(client, {
        keyboard,
        touchEvent(type, touches) {
            const event = {
                touches, defaultPrevented: false, stopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopImmediatePropagation() { this.stopped = true; }
            };
            for (const [callback, options] of client.mainEvents.get(type) || []) {
                if (options?.capture) callback(event);
                if (event.stopped) break;
            }
            // The remote input devices are below .client-main in the real DOM.
            // Only a touch that passes its capture listener reaches them.
            if (!event.stopped) {
                if (multiTouchSupport) {
                    client.touch.emit({ type, state: { x: 100, y: 100, force: 1 },
                        preventDefault() {} });
                }
                else {
                    const device = absolute ? client.touchscreen : client.touchpad;
                    device.emit(mouseEvent(type === 'touchstart' ? 'mousedown'
                        : type === 'touchend' ? 'mouseup' : 'mousemove', 100));
                }
            }
            return event;
        }
    });
}

test('production client pans locally in absolute, relative and remote multitouch modes', () => {
    for (const options of [
        { absolute: false }, { absolute: true },
        { absolute: true, multiTouchSupport: 2 }
    ]) {
        const client = clientFixture(options);
        assert.equal(client.touchEvent('touchstart', [finger(0, 100, 200)]).defaultPrevented, true);
        client.touchEvent('touchmove', [finger(0, 100, 100)]);
        client.touchEvent('touchend', []);
        assert.equal(client.main.scrollTop, 100);
        assert.equal(client.scope.client.clientProperties.scrollTop, 100);
        assert.deepEqual(client.sent, []);

        // Explicitly leaving Pan mode restores the selected remote touch path.
        client.keyboard.panning = false;
        client.touchEvent('touchstart', [finger(1, 100, 100)]);
        assert.equal(client.sent.length, 1);
        assert.equal(client.sent[0][1], options.multiTouchSupport ? 'touch' : 'mouse');
    }
});

test('Pan preserves hardware mouse and synthetic typing while disabled native mode and teardown restore touch', () => {
    const client = clientFixture({ absolute: false });
    client.mouse.emit(mouseEvent('mousedown', 100, { left: true }));
    client.scope.$broadcast('guacSyntheticKeydown', 0x61);
    client.scope.$broadcast('guacSyntheticKeyup', 0x61);
    assert.deepEqual(client.sent.map(row => row.slice(0, 2)), [
        ['first', 'mouse'], ['first', 'key'], ['first', 'key']
    ]);

    client.sent.length = 0;
    client.keyboard.enabled = false;
    client.touchEvent('touchstart', [finger(0, 100, 200)]);
    client.touchEvent('touchend', []);
    assert.equal(client.sent.length, 2);
    client.scope.$broadcast('$destroy');
    for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
        assert.equal(client.mainEvents.get(name).size, 0);
});
