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
const { sources, fakeClock } = require('./helpers/client-fixtures');

const ClientTouchScroll = sources(['client/types/ClientTouchScroll.js'])
    .factories.ClientTouchScroll();
const finger = (identifier, x, y) => ({ identifier, clientX: x, clientY: y });

function fixture() {
    const listeners = new Map();
    const wheels = [];
    const remote = [];
    const clock = fakeClock();
    let enabled = true;
    const element = {
        addEventListener(type, callback, options) {
            assert.equal(options.capture, true);
            assert.equal(options.passive, false);
            listeners.set(type, callback);
        },
        removeEventListener(type, callback, options) {
            assert.equal(listeners.get(type), callback);
            assert.equal(options.capture, true);
            listeners.delete(type);
        }
    };
    const scroll = new ClientTouchScroll(element, () => enabled,
        (x, y) => wheels.push([clock.now(), x, y]), clock.window);
    return {
        listeners, wheels, remote, clock, scroll,
        setEnabled(value) { enabled = value; },
        event(type, touches) {
            const event = { touches, prevented: false, stopped: false,
                preventDefault() { this.prevented = true; },
                stopImmediatePropagation() { this.stopped = true; } };
            listeners.get(type)?.(event);
            if (!event.stopped)
                remote.push(type);
            return event;
        }
    };
}

test('one finger emits integer remote wheel directions with sub-notch accumulation', () => {
    const view = fixture();
    assert.equal(view.event('touchstart', [finger(7, 100, 100)]).prevented, true);
    view.event('touchmove', [finger(7, 91, 91)]);
    assert.deepEqual(view.wheels, []);
    view.event('touchmove', [finger(7, 80, 80)]);
    assert.deepEqual(view.wheels, [[0, 1, 1]]);
    view.clock.advance(16);
    view.event('touchmove', [finger(7, 100, 100)]);
    assert.deepEqual(view.wheels, [[0, 1, 1], [16, -1, -1]]);
    view.event('touchend', []);
    assert.deepEqual(view.remote, []);
});

test('large or dense moves have one bounded timer and at most two notches per interval', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 0, 0)]);
    for (let i = 1; i <= 100; i++) {
        view.event('touchmove', [finger(1, -1000 * i, -1000 * i)]);
        assert(view.clock.timers.size <= 1);
    }
    assert.equal(view.wheels.length, 1);
    view.clock.advance(1000);
    assert(view.wheels.length <= 5, 'saturation bounds total pending movement');
    for (let i = 0; i < view.wheels.length; i++) {
        const [time, x, y] = view.wheels[i];
        assert(Number.isInteger(x) && Number.isInteger(y));
        assert(Math.abs(x) + Math.abs(y) <= 2);
        if (i)
            assert(time - view.wheels[i - 1][0] >= 16);
    }
    assert.equal(view.clock.timers.size, 0);
});

test('disabled mode passes through touches and cannot steal a remote gesture mid-contact', () => {
    const view = fixture();
    view.setEnabled(false);
    assert.equal(view.event('touchstart', [finger(1, 100, 100)]).prevented, false);
    view.setEnabled(true);
    view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 200)]);
    view.event('touchmove', [finger(1, 20, 20), finger(2, 120, 120)]);
    view.event('touchend', [finger(1, 20, 20)]);
    view.event('touchmove', [finger(1, 0, 0)]);
    view.event('touchend', []);
    assert.deepEqual(view.remote, ['touchstart', 'touchstart', 'touchmove', 'touchend', 'touchmove', 'touchend']);
    assert.deepEqual(view.wheels, []);
});

test('mode disable cancels pending wheels but keeps its stream captured through release', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100)]);
    view.event('touchmove', [finger(1, 100, 0)]);
    assert.equal(view.clock.timers.size, 1);
    view.setEnabled(false);
    view.event('touchmove', [finger(1, 100, -100)]);
    view.setEnabled(true);
    view.event('touchmove', [finger(1, 100, -200)]);
    view.event('touchend', []);
    view.clock.advance(1000);
    assert.deepEqual(view.wheels, [[0, 0, 2]]);
    assert.deepEqual(view.remote, []);
    assert.equal(view.clock.timers.size, 0);
});

test('multitouch blocks scrolling for the full gesture and never resumes on one remaining finger', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100)]);
    view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 200)]);
    view.event('touchmove', [finger(1, 100, 0), finger(2, 200, 100)]);
    view.event('touchend', [finger(1, 100, 0)]);
    view.event('touchmove', [finger(1, 100, -100)]);
    view.event('touchend', []);
    assert.deepEqual(view.wheels, []);
    assert.deepEqual(view.remote, []);
    view.event('touchstart', [finger(3, 100, 100)]);
    view.event('touchmove', [finger(3, 100, 80)]);
    assert.deepEqual(view.wheels, [[0, 0, 1]]);
});

test('end, cancel and dispose have no inertia or callbacks after contact release', () => {
    for (const finish of ['touchend', 'touchcancel', 'cancel', 'dispose']) {
        const view = fixture();
        view.event('touchstart', [finger(1, 100, 100)]);
        view.event('touchmove', [finger(1, 100, 0)]);
        assert.equal(view.clock.timers.size, 1);
        if (finish === 'cancel' || finish === 'dispose')
            view.scroll[finish]();
        else
            view.event(finish, []);
        view.clock.advance(1000);
        assert.equal(view.clock.timers.size, 0);
        assert.deepEqual(view.wheels, [[0, 0, 2]]);
        if (finish === 'dispose')
            assert.equal(view.listeners.size, 0);
        else {
            view.event('touchmove', [finger(1, 100, -100)]);
            assert.deepEqual(view.wheels, [[0, 0, 2]]);
        }
    }
});

test('invalid coordinates and changed contact identity rebase without jumps', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100)]);
    view.event('touchmove', [finger(1, NaN, 0)]);
    view.event('touchmove', [finger(1, 100, -100)]);
    view.event('touchmove', [finger(2, 100, -1000)]);
    assert.deepEqual(view.wheels, []);
    view.event('touchmove', [finger(2, 100, -1020)]);
    assert.deepEqual(view.wheels, [[0, 0, 1]]);
    view.event('touchend', []);
    view.event('touchstart', [finger(3, 0, 0)]);
    view.event('touchmove', [finger(3, 0, -100)]);
    assert.equal(view.wheels.length, 1, 'new gestures cannot bypass the rate limit');
});
