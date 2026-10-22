/*
 * Modified for Greenmole by its maintainers.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources, directiveFixture, mouseEvent } = require('./helpers/client-fixtures');
const finger = (x, y, identifier = 0) => ({ identifier, clientX: x, clientY: y });

function fixture({ absolute = false, multiTouchSupport = 0, blocked = false } = {}) {
    const keyboard = sources(['textInput/services/guacNativeKeyboard.js'])
        .factories.guacNativeKeyboard({ navigator: {} });
    keyboard.setEnabled(true);
    keyboard.setScrolling(true);
    const f = directiveFixture({ nativeKeyboard: keyboard, blocked });
    f.scope.emulateAbsoluteMouse = absolute;
    f.scope.client.multiTouchSupport = multiTouchSupport;
    f.configureTouch();
    Object.assign(f.main, { clientWidth: 1000, clientHeight: 600,
        scrollWidth: 3840, scrollHeight: 2160 });
    f.main.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 });
    f.container.getBoundingClientRect = () => ({ left: -f.main.scrollLeft,
        top: -f.main.scrollTop, width: 3840, height: 2160 });
    f.displays[0].moveCursor(80, 120);
    f.keyboard = keyboard;
    f.fire = (type, touches) => {
        const event = { touches, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopImmediatePropagation() { this.stopped = true; } };
        for (const [callback, options] of f.mainEvents.get(type) || []) {
            if (options?.capture) callback(event);
            if (event.stopped) break;
        }
        if (!event.stopped) {
            if (multiTouchSupport && absolute)
                f.touch.emit({ type, state: { x: 100, y: 100, force: 1 }, preventDefault() {} });
            else
                (absolute ? f.touchscreen : f.touchpad).emit(mouseEvent(
                    type === 'touchstart' ? 'mousedown' : type === 'touchend' ? 'mouseup' : 'mousemove',
                    100, { left: type !== 'touchend' }));
        }
        return event;
    };
    return f;
}

test('remote wheel sends bounded vertical/horizontal pairs in every touch mode without clicks or local movement', () => {
    for (const options of [{ absolute: false }, { absolute: true },
        { absolute: true, multiTouchSupport: 2 }]) {
        const f = fixture(options);
        assert.equal(f.fire('touchstart', [finger(100, 200)]).defaultPrevented, true);
        f.fire('touchmove', [finger(100, 140)]);
        f.fire('touchend', []);
        assert.equal(f.sent.length, 5);
        assert(f.sent.every(row => row[1] === 'mouse' && row[2] === 80 && row[3] === 120
            && !row[4] && !row[5] && !row[6]));
        assert.equal(f.sent[0].slice(4).some(Boolean), false, 'ordinary pointer move precedes wheel input');
        assert.equal(f.sent[1][8], true);
        assert.equal(f.sent[2][8], false);
        f.sent.length = 0;
        f.clock.advance(16);
        f.fire('touchstart', [finger(100, 200)]);
        f.fire('touchmove', [finger(40, 200)]);
        f.fire('touchend', []);
        assert.equal(f.sent.length, 5);
        assert.equal(f.sent[1][10], true, 'finger left scrolls right');
        assert.equal(f.sent[2].slice(4).some(Boolean), false, 'wheel release carries no phantom button');
        assert.equal(f.main.scrollLeft, 0);
        assert.equal(f.main.scrollTop, 0);
        assert.equal(f.clock.timers.size, 0);
        f.scope.$broadcast('$destroy');
    }
});

test('mode handover cancels pending wheel movement and never leaks its contacts to Pan or remote clicks', () => {
    const f = fixture();
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, -1000)]);
    const sent = f.sent.length;
    f.keyboard.setPanning(true);
    assert.equal(f.keyboard.scrolling, false);
    f.fire('touchmove', [finger(100, -1500)]);
    f.fire('touchend', []);
    f.clock.advance(1000);
    assert.equal(f.sent.length, sent);
    assert.equal(f.main.scrollTop, 0);
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, 100)]);
    f.fire('touchend', []);
    assert.equal(f.main.scrollTop, 100);
    assert.equal(f.sent.length, sent);
    f.scope.$broadcast('$destroy');
});

test('clipboard synchronization drops wheel gestures instead of replaying a scroll backlog', () => {
    const f = fixture({ blocked: true });
    f.scope.$broadcast('guacSyntheticKeydown', 0x61);
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, 190)]); // Below threshold, still belongs to the blocked period.
    f.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(f.sent, [['first', 'key', 1, 0x61]]);
    f.fire('touchmove', [finger(100, 100)]);
    f.fire('touchend', []);
    f.clock.advance(1000);
    assert.equal(f.sent.length, 1);
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, 160)]);
    f.fire('touchend', []);
    assert.equal(f.sent.length, 6);
    f.scope.$broadcast('$destroy');
});

test('a reentrant client replacement still receives the original wheel release and no further old input', () => {
    const f = fixture();
    const original = f.scope.client.client;
    const send = original.sendMouseState;
    let replaced = false;
    original.sendMouseState = state => {
        send(state);
        if (state.down && !replaced) {
            replaced = true;
            f.attach(f.managed('replacement'));
        }
    };
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, 100)]);
    f.fire('touchend', []);
    f.clock.advance(1000);
    assert.equal(f.sent.length, 3);
    assert.equal(f.sent[0][0], 'first');
    assert.equal(f.sent[1][8], true);
    assert.equal(f.sent[2][0], 'first');
    assert.equal(f.sent[2][8], false);
    f.scope.$broadcast('$destroy');
});

test('disconnect and destruction cancel queued wheel work while preserving held hardware buttons', () => {
    const f = fixture();
    f.mouse.emit(mouseEvent('mousedown', 160, { right: true }));
    f.sent.length = 0;
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, -1000)]);
    assert(f.sent.every(row => row[6] === true), 'wheel pair preserves an existing hardware right button');
    const count = f.sent.length;
    f.scope.client.clientState.connectionState = 'DISCONNECTED';
    f.watches.get('client.clientState.connectionState')('DISCONNECTED');
    f.clock.advance(1000);
    assert.equal(f.sent.length, count);
    f.scope.$broadcast('$destroy');
    assert.equal(f.clock.timers.size, 0);
    for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
        assert.equal(f.mainEvents.get(name).size, 0);
});

test('scroll seeds the host pointer at the visible clamped cursor before wheel pulses', () => {
    const f = fixture();
    f.displays[0].moveCursor(1500, 800);
    f.fire('touchstart', [finger(100, 200)]);
    f.fire('touchmove', [finger(100, 160)]);
    f.fire('touchend', []);
    assert.equal(f.sent.length, 5);
    const movement = f.sent[0];
    assert(movement[2] >= 0 && movement[2] < 500);
    assert(movement[3] >= 0 && movement[3] < 300);
    assert.equal(movement.slice(4).some(Boolean), false);
    assert(f.sent.slice(1).every(row => row[2] === movement[2] && row[3] === movement[3]));
    f.scope.$broadcast('$destroy');
});
