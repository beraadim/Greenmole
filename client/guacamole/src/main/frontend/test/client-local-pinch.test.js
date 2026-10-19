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

// Modified for Greenmole by its maintainers.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources } = require('./helpers/client-fixtures');
const ClientLocalPan = sources(['client/types/ClientLocalPan.js']).factories.ClientLocalPan();
const finger = (identifier, x, y) => ({ identifier, clientX: x, clientY: y });

function fixture() {
    const listeners = new Map();
    const scrolls = [];
    const pinches = [];
    const remote = [];
    let enabled = true;
    let starts = 0;
    const element = {
        scrollLeft: 200, scrollTop: 300,
        scrollWidth: 2000, scrollHeight: 1600,
        clientWidth: 1000, clientHeight: 600,
        addEventListener(name, callback, options) {
            assert.equal(options.capture, true);
            assert.equal(options.passive, false);
            listeners.set(name, callback);
        },
        removeEventListener(name, callback) {
            assert.equal(listeners.get(name), callback);
            listeners.delete(name);
        }
    };
    const pan = new ClientLocalPan(element, () => enabled,
        (left, top) => scrolls.push([left, top]), () => starts++,
        change => pinches.push({ ...change }));
    return {
        element, pan, scrolls, pinches, remote, listeners,
        get starts() { return starts; },
        setEnabled(value) { enabled = value; },
        event(type, touches) {
            const event = {
                touches, prevented: false, stopped: false,
                preventDefault() { this.prevented = true; },
                stopImmediatePropagation() { this.stopped = true; }
            };
            listeners.get(type)?.(event);
            if (!event.stopped) remote.push(type);
            return event;
        }
    };
}

test('pinch reports incremental zoom and anchors without remote touch or implicit scrolling', () => {
    const view = fixture();
    assert.equal(view.event('touchstart', [finger(1, 100, 200), finger(2, 200, 200)]).prevented, true);
    view.event('touchmove', [finger(1, 50, 250), finger(2, 250, 250)]);
    view.event('touchmove', [finger(1, 25, 250), finger(2, 275, 250)]);
    view.event('touchend', []);
    assert.deepEqual(view.pinches, [
        { scaleFactor: 2, clientX: 150, clientY: 250, previousClientX: 150, previousClientY: 200 },
        { scaleFactor: 1.25, clientX: 150, clientY: 250, previousClientX: 150, previousClientY: 250 }
    ]);
    assert.deepEqual(view.scrolls, []);
    assert.deepEqual([view.element.scrollLeft, view.element.scrollTop], [200, 300]);
    assert.deepEqual(view.remote, []);
    assert.equal(view.starts, 1);
});

test('two-finger translation is reported at unchanged zoom and contact reordering is harmless', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
    view.event('touchmove', [finger(2, 240, 130), finger(1, 140, 130)]);
    assert.deepEqual(view.pinches, [
        { scaleFactor: 1, clientX: 190, clientY: 130, previousClientX: 150, previousClientY: 100 }
    ]);
    view.event('touchmove', [finger(1, 140, 130), finger(2, 240, 130)]);
    assert.equal(view.pinches.length, 1, 'stationary contacts do not emit duplicate work');
    assert.deepEqual(view.remote, []);
});

test('one-to-two-to-one transitions rebase without jumps and resume both-axis dragging', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 200)]);
    view.event('touchmove', [finger(1, 80, 150)]);
    view.event('touchstart', [finger(1, 80, 150), finger(2, 180, 150)]);
    view.event('touchmove', [finger(1, 30, 150), finger(2, 230, 150)]);
    // Keep the second contact: matching by ID rather than original order also
    // makes a partial release an ordinary new drag baseline.
    view.event('touchend', [finger(2, 230, 150)]);
    view.event('touchmove', [finger(2, 210, 120)]);
    view.event('touchend', []);
    assert.deepEqual(view.scrolls, [[220, 350], [240, 380]]);
    assert.equal(view.pinches.length, 1);
    assert.equal(view.pinches[0].scaleFactor, 2);
    assert.equal(view.starts, 1);
    assert.deepEqual(view.remote, []);
});

test('third contacts suspend motion and establish a new baseline when a pair remains', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
    view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 100), finger(3, 300, 100)]);
    view.event('touchmove', [finger(1, 0, 0), finger(2, 400, 0), finger(3, 900, 0)]);
    assert.deepEqual(view.pinches, []);
    view.event('touchend', [finger(1, 0, 0), finger(3, 900, 0)]);
    view.event('touchmove', [finger(1, 0, 0), finger(3, 450, 0)]);
    assert.equal(view.pinches.length, 1);
    assert.equal(view.pinches[0].scaleFactor, 0.5);
    assert.deepEqual(view.remote, []);
});

test('coincident contacts and replaced identifiers rebase before producing finite zoom', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100), finger(2, 100, 100)]);
    view.event('touchmove', [finger(1, 50, 100), finger(2, 150, 100)]);
    assert.deepEqual(view.pinches, []);
    view.event('touchmove', [finger(1, 0, 100), finger(2, 200, 100)]);
    assert.equal(view.pinches[0].scaleFactor, 2);
    view.event('touchmove', [finger(1, 0, 100), finger(3, 300, 100)]);
    assert.equal(view.pinches.length, 1);
    view.event('touchmove', [finger(1, 0, 100), finger(3, 150, 100)]);
    assert.equal(view.pinches[1].scaleFactor, 0.5);
});

test('mode changes retain local or remote ownership for the complete pinch gesture', () => {
    const view = fixture();
    view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
    view.setEnabled(false);
    view.event('touchmove', [finger(1, 50, 100), finger(2, 250, 100)]);
    view.event('touchend', [finger(1, 50, 100)]);
    view.event('touchmove', [finger(1, 40, 90)]);
    view.event('touchend', []);
    assert.equal(view.pinches.length, 0);
    assert.deepEqual(view.scrolls, []);
    assert.deepEqual(view.remote, []);
    view.event('touchstart', [finger(3, 100, 100)]);
    view.setEnabled(true);
    view.event('touchstart', [finger(3, 100, 100), finger(4, 200, 100)]);
    view.event('touchmove', [finger(3, 50, 100), finger(4, 250, 100)]);
    view.event('touchend', []);
    assert.deepEqual(view.remote, ['touchstart', 'touchstart', 'touchmove', 'touchend']);
    assert.equal(view.pinches.length, 0);
});

test('partial touchcancel and explicit cancellation suppress movement without leaking releases', () => {
    for (const cancellation of ['touchcancel', 'explicit']) {
        const view = fixture();
        view.event('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
        if (cancellation === 'explicit') view.pan.cancel();
        else view.event('touchcancel', [finger(1, 100, 100)]);
        view.event('touchmove', [finger(1, 50, 50)]);
        view.event('touchstart', [finger(1, 50, 50), finger(3, 300, 300)]);
        view.event('touchmove', [finger(1, 0, 0), finger(3, 600, 600)]);
        view.event('touchend', []);
        assert.deepEqual(view.pinches, []);
        assert.deepEqual(view.scrolls, []);
        assert.deepEqual(view.remote, []);
        view.event('touchstart', [finger(4, 100, 100)]);
        view.event('touchmove', [finger(4, 80, 90)]);
        assert.deepEqual(view.scrolls, [[220, 310]]);
        view.pan.dispose();
        assert.equal(view.listeners.size, 0);
    }
});
