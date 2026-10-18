/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources, directiveFixture, mouseEvent, fakeClock } = require('./helpers/client-fixtures');

function resizeFixture() {
    const clock = fakeClock();
    const loaded = sources(['client/types/ClientResizeQueue.js']);
    const Type = loaded.factories.ClientResizeQueue(clock.window);
    const sent = [];
    const queue = new Type((width, height) => sent.push([clock.now(), width, height]));
    queue.acknowledge(1920, 1080);
    queue.setConnected(true);
    return { clock, queue, sent, Type };
}

function viewport(fixture, width, height) {
    fixture.main.offsetWidth = width;
    fixture.main.offsetHeight = height;
    fixture.scope.mainElementResized();
}

function acknowledge(fixture, width, height) {
    fixture.displays.at(-1).getWidth = () => width;
    fixture.displays.at(-1).getHeight = () => height;
    fixture.watches.get('client.managedDisplay.size')();
}

test('runtime pixels use handshake rounding with even width only for RDP', () => {
    const { Type } = resizeFixture();
    assert.deepEqual({ ...Type.normalize(1273, 895, 1.25, true) }, { width: 1590, height: 1118 });
    assert.deepEqual({ ...Type.normalize(1273, 895, 1.25, false) }, { width: 1591, height: 1118 });
    assert.deepEqual({ ...Type.normalize(1273, 895, 0, true) }, { width: 1272, height: 895 });
});

test('a fullscreen resize burst sends its final viewport after 150ms of quiet', () => {
    const { clock, queue, sent } = resizeFixture();
    queue.request(1272, 896);
    clock.advance(50);
    queue.request(1920, 944);
    clock.advance(50);
    queue.request(2560, 1304);
    clock.advance(149);
    assert.deepEqual(sent, []);
    clock.advance(1);
    assert.deepEqual(sent, [[250, 2560, 1304]]);
});

test('continuous resizing cannot postpone a remote size beyond 500ms', () => {
    const { clock, queue, sent } = resizeFixture();
    for (let i = 0; i < 5; i++) {
        queue.request(1000 + i * 20, 800);
        clock.advance(100);
    }
    assert.deepEqual(sent, [[500, 1080, 800]]);
});

test('duplicate callbacks neither postpone settling nor repeat an outstanding request', () => {
    const { clock, queue, sent } = resizeFixture();
    queue.request(1280, 800);
    clock.advance(100);
    queue.request(1280, 800);
    clock.advance(50);
    queue.request(1280, 800);
    clock.advance(1000);
    assert.deepEqual(sent, [[150, 1280, 800]]);
    queue.acknowledge(1280, 800);
    clock.advance(3000);
    assert.deepEqual(sent, [[150, 1280, 800]]);
    assert.equal(clock.timers.size, 0);
});

test('an ignored resize gets bounded retries and a later viewport is not permanently suppressed', () => {
    const { clock, queue, sent } = resizeFixture();
    queue.request(1280, 800);
    clock.advance(10000);
    assert.deepEqual(sent, [[150, 1280, 800], [1650, 1280, 800], [3150, 1280, 800]]);
    assert.equal(clock.timers.size, 0);
    queue.request(1280, 800);
    clock.advance(150);
    assert.deepEqual(sent.at(-1), [10150, 1280, 800]);
    queue.request(1366, 900);
    clock.advance(150);
    assert.deepEqual(sent.at(-1), [10300, 1366, 900]);
});

test('the newest desired size supersedes pending work despite an older acknowledgement', () => {
    const { clock, queue, sent } = resizeFixture();
    queue.request(1280, 800);
    clock.advance(200);
    queue.request(2560, 1440);
    clock.advance(150);
    queue.acknowledge(1280, 800);
    clock.advance(200);
    queue.acknowledge(2560, 1440);
    clock.advance(5000);
    assert.deepEqual(sent, [[150, 1280, 800], [350, 2560, 1440]]);
});

test('returning to the observed size supersedes an outstanding conflicting resize', () => {
    const { clock, queue, sent } = resizeFixture();
    queue.request(1280, 800);
    clock.advance(200);
    queue.request(1920, 1080);
    clock.advance(150);
    assert.deepEqual(sent, [[150, 1280, 800], [350, 1920, 1080]]);
});

test('a late acknowledgement cannot leave the display at an obsolete viewport', () => {
    const { clock, queue, sent } = resizeFixture();
    queue.request(1280, 800);
    clock.advance(200);
    queue.request(2560, 1440);
    clock.advance(150);
    queue.acknowledge(2560, 1440);
    clock.advance(100);
    queue.acknowledge(1280, 800);
    assert.deepEqual(sent.at(-1), [450, 2560, 1440]);
});

test('zero, nonfinite and fractional request dimensions do not schedule work', () => {
    const { queue, clock, sent } = resizeFixture();
    for (const width of [0, -1, Infinity, NaN, 1280.5]) queue.request(width, 800);
    clock.advance(10000);
    assert.deepEqual(sent, []);
    assert.equal(clock.timers.size, 0);
});

test('detaching or destroying cancels settling and retries, including reentrant teardown', () => {
    const { queue, clock, sent, Type } = resizeFixture();
    queue.request(1280, 800);
    clock.advance(100);
    queue.clear();
    clock.advance(2000);
    assert.deepEqual(sent, []);
    queue.setConnected(true);
    queue.request(1366, 900);
    clock.advance(150);
    queue.dispose();
    clock.advance(10000);
    assert.deepEqual(sent, [[2250, 1366, 900]]);
    assert.equal(clock.timers.size, 0);

    let reentrant;
    reentrant = new Type(() => reentrant.dispose());
    reentrant.setConnected(true);
    reentrant.request(1280, 800);
    clock.advance(150);
    assert.equal(clock.timers.size, 0);
});

test('initial connection happens once with known CSS dimensions and applies the newest connecting viewport', () => {
    const fixture = directiveFixture({ state: 'IDLE', density: 1.25 });
    viewport(fixture, 1273, 895);
    fixture.clock.advance(50);
    viewport(fixture, 1601, 899);
    fixture.clock.advance(250);
    assert.deepEqual(fixture.connections, [['first', 1273, 895]]);
    assert.deepEqual(fixture.sent, []);
    fixture.watches.get('client.clientState.connectionState')('WAITING');
    assert.deepEqual(fixture.sent, [['first', 'size', 2000, 1123]]);
});

test('entering WAITING remeasures a viewport that grew during the handshake without a resize notification', () => {
    const fixture = directiveFixture({ state: 'IDLE' });
    viewport(fixture, 1280, 720);
    fixture.main.offsetWidth = 1600;
    fixture.main.offsetHeight = 900;
    fixture.clock.advance(300);
    fixture.watches.get('client.clientState.connectionState')('WAITING');
    fixture.clock.advance(150);
    assert.deepEqual(fixture.connections, [['first', 1280, 720]]);
    assert.deepEqual(fixture.sent, [['first', 'size', 1600, 900]]);
    acknowledge(fixture, 1600, 900);
    fixture.clock.advance(10000);
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.clock.timers.size, 0);
});

test('entering CONNECTED remeasures final layout without reconnecting or repeating acknowledged sizes', () => {
    const fixture = directiveFixture({ state: 'IDLE' });
    viewport(fixture, 1280, 720);
    fixture.watches.get('client.clientState.connectionState')('WAITING');
    fixture.clock.advance(150);
    acknowledge(fixture, 1280, 720);
    fixture.main.offsetWidth = 1920;
    fixture.main.offsetHeight = 1080;
    fixture.watches.get('client.clientState.connectionState')('CONNECTED');
    fixture.clock.advance(150);
    assert.deepEqual(fixture.connections, [['first', 1280, 720]]);
    assert.deepEqual(fixture.sent, [['first', 'size', 1280, 720], ['first', 'size', 1920, 1080]]);
    acknowledge(fixture, 1920, 1080);
    fixture.clock.advance(10000);
    assert.equal(fixture.sent.length, 2);
    assert.equal(fixture.clock.timers.size, 0);
});

test('connection transitions keep unknown dimensions deferred and teardown cancels their later request', () => {
    const fixture = directiveFixture({ state: 'IDLE' });
    fixture.watches.get('client.clientState.connectionState')('WAITING');
    fixture.clock.advance(5000);
    assert.deepEqual(fixture.connections, []);
    assert.deepEqual(fixture.sent, []);
    viewport(fixture, 1600, 900);
    assert.deepEqual(fixture.connections, [['first', 1600, 900]]);
    fixture.scope.$broadcast('$destroy');
    fixture.clock.advance(10000);
    assert.deepEqual(fixture.sent, []);
    assert.equal(fixture.clock.timers.size, 0);
    assert.equal(fixture.clock.events.get('resize').size, 0);
});

test('fractional DPR does not repeatedly request a size the RDP server already normalized', () => {
    const fixture = directiveFixture({ density: 1.25 });
    acknowledge(fixture, 1590, 1118);
    viewport(fixture, 1273, 895);
    fixture.clock.advance(10000);
    assert.deepEqual(fixture.sent, []);
    assert.equal(fixture.clock.timers.size, 0);
});

test('late protocol detection normalizes RDP width without changing other protocols', () => {
    const fixture = directiveFixture({ density: 1.25, protocol: null });
    viewport(fixture, 1273, 895);
    fixture.clock.advance(100);
    fixture.scope.client.protocol = 'rdp';
    fixture.watches.get('client.protocol')();
    fixture.clock.advance(150);
    assert.deepEqual(fixture.sent, [['first', 'size', 1590, 1118]]);

    const vnc = directiveFixture({ density: 1.25, protocol: 'vnc' });
    viewport(vnc, 1273, 895);
    vnc.clock.advance(150);
    assert.deepEqual(vnc.sent, [['first', 'size', 1591, 1118]]);
});

test('local scaling and pointer input remain immediate while remote resizing settles', () => {
    const fixture = directiveFixture({ density: 2 });
    fixture.scope.client.clientProperties.autoFit = true;
    viewport(fixture, 1000, 600);
    const scale = fixture.scope.client.clientProperties.scale;
    assert.equal(scale, 1000 / 1920);
    fixture.watches.get('client.clientProperties.scale')(scale);
    fixture.mouse.emit(mouseEvent('mousedown', 100, { left: true }));
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.sent[0][1], 'mouse');
    assert.equal(fixture.sent[0][2], 192);
    fixture.clock.advance(150);
    assert.deepEqual(fixture.sent.at(-1), ['first', 'size', 2000, 1200]);
});

test('a monitor DPR transition resizes even when CSS dimensions stay unchanged', () => {
    const fixture = directiveFixture();
    viewport(fixture, 1000, 600);
    fixture.clock.advance(150);
    acknowledge(fixture, 1000, 600);
    fixture.services.$window.devicePixelRatio = 2;
    fixture.clock.emit('resize');
    fixture.clock.advance(150);
    assert.deepEqual(fixture.sent, [['first', 'size', 1000, 600], ['first', 'size', 2000, 1200]]);
    fixture.scope.$broadcast('$destroy');
    assert.equal(fixture.clock.events.get('resize').size, 0);
    assert.equal(fixture.clock.timers.size, 0);
});

test('replacing a connected view cancels old pending work even if connection state is unchanged', () => {
    const fixture = directiveFixture();
    viewport(fixture, 1280, 800);
    fixture.clock.advance(100);
    fixture.attach(fixture.managed('second'));
    fixture.clock.advance(150);
    assert.deepEqual(fixture.sent, [['second', 'size', 1280, 800]]);
    fixture.scope.$broadcast('$destroy');
    fixture.clock.advance(10000);
    assert.equal(fixture.sent.length, 1);
});
