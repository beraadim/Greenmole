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
const { queue, eventBus, directiveFixture, mouseEvent, deferred, clipboardFixture } = require('./helpers/client-fixtures');

test('the gate sends immediately without promises or polling when unblocked', () => {
    const input = queue();
    const sent = [];
    input.enqueue(() => sent.push(1));
    assert.deepEqual(sent, [1]);
});

test('only adjacent queued free movements coalesce across an ordered input barrier', () => {
    const input = queue();
    const sent = [];
    input.setBlocked(true);
    for (let i = 0; i < 1000; i++) input.enqueue(() => sent.push(i), true);
    input.enqueue(() => sent.push('click'));
    input.enqueue(() => sent.push('move-a'), true);
    input.enqueue(() => sent.push('move-b'), true);
    input.enqueue(() => sent.push('release'));
    input.setBlocked(false);
    assert.deepEqual(sent, [999, 'click', 'move-b', 'release']);
});

test('reentrant input remains ordered and a new synchronization can pause draining', () => {
    const input = queue();
    const sent = [];
    input.setBlocked(true);
    input.enqueue(() => { sent.push(1); input.enqueue(() => sent.push(3)); input.setBlocked(true); });
    input.enqueue(() => sent.push(2));
    input.setBlocked(false);
    assert.deepEqual(sent, [1]);
    input.setBlocked(false);
    assert.deepEqual(sent, [1, 2, 3]);
});

test('a pending clipboard read leaves the local cursor responsive and snapshots scale', () => {
    const fixture = directiveFixture({ blocked: true });
    const event = mouseEvent('mousemove', 120);
    fixture.mouse.emit(event);
    event.state.x = 999;
    fixture.displays[0].getScale = () => 4;
    assert.deepEqual(fixture.cursor, [['visible', true], [60, 10]]);
    assert.deepEqual(fixture.sent, []);
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent.map(row => row.slice(0, 4)), [['first', 'mouse', 60, 10]]);
});

test('queued hover moves flush before clicks and held-button paths and wheel pulses are preserved', () => {
    const fixture = directiveFixture({ blocked: true });
    const events = [
        mouseEvent('mousemove', 10), mouseEvent('mousemove', 20),
        mouseEvent('mousedown', 30, { left: true }),
        mouseEvent('mousemove', 40, { left: true }), mouseEvent('mousemove', 50, { left: true }),
        mouseEvent('mouseup', 60),
        mouseEvent('mousedown', 60, { up: true }), mouseEvent('mouseup', 60),
        mouseEvent('mousedown', 60, { down: true }), mouseEvent('mouseup', 60)
    ];
    events.forEach(event => fixture.mouse.emit(event));
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent.map(row => [row[2], row[4], row[7], row[8]]), [
        [10, false, false, false], [15, true, false, false],
        [20, true, false, false], [25, true, false, false], [30, false, false, false],
        [30, false, true, false], [30, false, false, false],
        [30, false, false, true], [30, false, false, false]
    ]);
});

test('refocus clipboard data and inferred modifiers arrive before the click and paste that depend on them', () => {
    const fixture = directiveFixture();
    fixture.root.$on('guacBeforeClientMouseDown', () => fixture.scope.$broadcast('guacKeydown', 0xFFE3));
    fixture.root.$on('guacClientMouseUp', () => fixture.scope.$broadcast('guacKeyup', 0xFFE3));
    fixture.root.$broadcast('clipboardSyncInProgress', true);
    fixture.mouse.emit(mouseEvent('mousedown', 20, { left: true }));
    fixture.mouse.emit(mouseEvent('mouseup', 20));
    fixture.scope.$broadcast('guacSyntheticKeydown', 0xFFE3);
    fixture.scope.$broadcast('guacSyntheticKeydown', 0x76);
    fixture.scope.$broadcast('guacSyntheticKeyup', 0x76);
    fixture.scope.$broadcast('guacSyntheticKeyup', 0xFFE3);
    assert.deepEqual(fixture.sent, []);
    fixture.scope.$broadcast('guacClipboard', { data: 'new local clipboard' });
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent.map(row => row.slice(0, 4)), [
        ['first', 'clipboard', 'new local clipboard'],
        ['first', 'key', 1, 0xFFE3], ['first', 'mouse', 10, 10],
        ['first', 'mouse', 10, 10], ['first', 'key', 0, 0xFFE3],
        ['first', 'key', 1, 0xFFE3], ['first', 'key', 1, 0x76],
        ['first', 'key', 0, 0x76], ['first', 'key', 0, 0xFFE3]
    ]);
});

test('keyboard input is a barrier between otherwise coalescible free movements', () => {
    const fixture = directiveFixture({ blocked: true });
    fixture.mouse.emit(mouseEvent('mousemove', 10));
    fixture.scope.$broadcast('guacKeydown', 0x61);
    fixture.mouse.emit(mouseEvent('mousemove', 20));
    fixture.mouse.emit(mouseEvent('mousemove', 30));
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent.map(row => row.slice(0, 4)), [
        ['first', 'mouse', 5, 10], ['first', 'key', 1, 0x61], ['first', 'mouse', 15, 10]
    ]);
});

test('emulated mouse input uses the same clipboard gate and immediate cursor feedback', () => {
    const fixture = directiveFixture({ blocked: true });
    fixture.configureTouch();
    fixture.touchpad.emit(mouseEvent('mousedown', 100, { left: true }));
    assert.deepEqual(fixture.sent, []);
    assert.deepEqual(fixture.cursor, [['visible', true], [50, 10]]);
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent.map(row => row.slice(0, 5)), [['first', 'mouse', 50, 10, true]]);
});

test('native touch and keyboard input remain ordered across clipboard synchronization', () => {
    const fixture = directiveFixture({ blocked: true });
    fixture.scope.client.multiTouchSupport = 2;
    fixture.configureTouch();
    fixture.touch.emit({ type: 'touchstart', state: { x: 40, y: 20, force: 1 }, preventDefault() {} });
    fixture.scope.$broadcast('guacKeydown', 0x61);
    fixture.touch.emit({ type: 'touchend', state: { x: 60, y: 30, force: 0 }, preventDefault() {} });
    assert.deepEqual(fixture.sent, []);
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent, [
        ['first', 'touch', 20, 10, 1], ['first', 'key', 1, 0x61], ['first', 'touch', 30, 15, 0]
    ]);
});

test('replacing or detaching a client drops queued input belonging to the old session', () => {
    const fixture = directiveFixture({ blocked: true });
    fixture.mouse.emit(mouseEvent('mousedown', 10, { left: true }));
    fixture.attach(fixture.managed('second'));
    fixture.mouse.emit(mouseEvent('mousemove', 40));
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    assert.deepEqual(fixture.sent.map(row => row.slice(0, 4)), [['second', 'mouse', 20, 10]]);
    fixture.attach(null);
    fixture.mouse.emit(mouseEvent('mousedown', 10));
    fixture.scope.$broadcast('guacClipboard', { data: 'ignored' });
    fixture.scope.$broadcast('guacKeyup', 0x61);
    assert.equal(fixture.sent.length, 1);
});

test('destroying the directive cancels queued input and unregisters the global sync listener', () => {
    const fixture = directiveFixture({ blocked: true });
    fixture.mouse.emit(mouseEvent('mousedown', 10, { left: true }));
    assert.equal(fixture.root.count('clipboardSyncInProgress'), 1);
    fixture.scope.$broadcast('$destroy');
    assert.equal(fixture.root.count('clipboardSyncInProgress'), 0);
    fixture.root.$broadcast('clipboardSyncInProgress', false);
    fixture.mouse.emit(mouseEvent('mousemove', 40));
    assert.deepEqual(fixture.sent, []);
    assert.equal(fixture.mouse.active.get('mousemove').size, 0);
});

test('an unresolved clipboard read allocates no polling and cannot replay input after teardown', async () => {
    const clipboard = clipboardFixture();
    const sync = clipboard.service.resyncClipboard();
    assert.equal(clipboard.service.resyncClipboard(), sync);
    assert.equal(clipboard.reads.length, 1);
    const fixture = directiveFixture({ root: clipboard.root, clipboardService: clipboard.service });
    for (let i = 0; i < 1000; i++) fixture.mouse.emit(mouseEvent('mousemove', i));
    fixture.mouse.emit(mouseEvent('mousedown', 1000, { left: true }));
    fixture.scope.$broadcast('guacSyntheticKeydown', 0x76);
    assert.equal(clipboard.service.isSyncInProgress(), true);
    assert.deepEqual(fixture.sent, []);
    fixture.scope.$broadcast('$destroy');
    clipboard.reads[0].resolve('eventually available');
    await sync;
    assert.deepEqual(fixture.sent, []);
    assert.deepEqual(clipboard.writes, []);
    // The service's own test listener is the only remaining subscription.
    assert.equal(clipboard.root.count('clipboardSyncInProgress'), 1);
});

test('overlapping resync requests share the complete read and publication', async () => {
    const fixture = clipboardFixture();
    const published = [];
    let duringPublication;
    fixture.root.$on('guacClipboard', (event, data) => {
        published.push(data.data);
        if (!duringPublication)
            duringPublication = fixture.service.resyncClipboard();
    });
    const first = fixture.service.resyncClipboard();
    const second = fixture.service.resyncClipboard();
    assert.equal(first, second);
    assert.equal(fixture.reads.length, 1);
    assert.deepEqual(fixture.state, [true]);
    fixture.reads[0].resolve('first');
    await first;
    await second;
    assert.equal(duringPublication, first);
    assert.equal(fixture.service.isSyncInProgress(), false);
    assert.deepEqual(fixture.state, [true, false]);
    assert.deepEqual(published, ['first']);
    assert.deepEqual(fixture.writes, []);

    const subsequent = fixture.service.resyncClipboard();
    assert.notEqual(subsequent, first);
    assert.equal(fixture.reads.length, 2);
    fixture.reads[1].resolve('second');
    await subsequent;
    assert.deepEqual(published, ['first', 'second']);
    assert.deepEqual(fixture.state, [true, false, true, false]);
});

test('a delayed local read releases ordered input without a redundant permission-gated write', async () => {
    const clipboard = clipboardFixture();
    const permission = deferred();
    clipboard.clipboard.writeText = text => {
        clipboard.writes.push(text);
        return permission.promise;
    };
    const fixture = directiveFixture({ root: clipboard.root, clipboardService: clipboard.service });
    clipboard.root.$on('guacClipboard', (event, data) => fixture.scope.$broadcast('guacClipboard', data));
    let now = 0;
    const timing = [];
    const push = fixture.sent.push;
    fixture.sent.push = function(...rows) {
        timing.push(...rows.map(row => [now, row[1]]));
        return push.apply(this, rows);
    };

    const sync = clipboard.service.resyncClipboard();
    assert.equal(clipboard.service.resyncClipboard(), sync);
    assert.equal(clipboard.reads.length, 1);
    fixture.scope.$broadcast('guacKeydown', 0xFFE3);
    fixture.scope.$broadcast('guacKeydown', 0x76);
    fixture.scope.$broadcast('guacKeyup', 0x76);
    fixture.scope.$broadcast('guacKeyup', 0xFFE3);
    fixture.mouse.emit(mouseEvent('mousedown', 20, { left: true }));
    fixture.mouse.emit(mouseEvent('mouseup', 20));
    assert.deepEqual(timing, []);

    // Model a realistic asynchronous read delay without a wall-clock sleep.
    // The local write would remain pending indefinitely if it were attempted.
    now = 80;
    clipboard.reads[0].resolve('current local clipboard');
    await sync;
    assert.deepEqual(clipboard.writes, []);
    assert.deepEqual(timing, [
        [80, 'clipboard'], [80, 'key'], [80, 'key'], [80, 'key'],
        [80, 'key'], [80, 'mouse'], [80, 'mouse']
    ]);
    assert.equal(fixture.sent[0][2], 'current local clipboard');
});

test('a reentrant resync during gate notification joins the already assigned operation', async () => {
    const fixture = clipboardFixture();
    let reentrant;
    fixture.root.$on('clipboardSyncInProgress', (event, active) => {
        if (active)
            reentrant = fixture.service.resyncClipboard();
    });
    const first = fixture.service.resyncClipboard();
    assert.equal(first, reentrant);
    assert.equal(fixture.reads.length, 1);
    fixture.reads[0].resolve('shared');
    await first;
    assert.deepEqual(fixture.state, [true, false]);
});

test('a remote clipboard write cannot prematurely release a pending local synchronization', async () => {
    const fixture = clipboardFixture();
    const sync = fixture.service.resyncClipboard();
    await fixture.service.setClipboard({ type: 'text/plain', data: 'remote data' });
    assert.equal(fixture.service.isSyncInProgress(), true);
    assert.deepEqual(fixture.state, [true]);
    fixture.reads[0].resolve('local data');
    await sync;
    assert.deepEqual(fixture.state, [true, false]);
});

test('clipboard read rejection releases the shared gate without losing later input', async () => {
    const fixture = clipboardFixture();
    const sync = fixture.service.resyncClipboard();
    fixture.reads[0].reject(new Error('Clipboard access denied'));
    await sync;
    assert.equal(fixture.service.isSyncInProgress(), false);
    assert.deepEqual(fixture.state, [true, false]);
});
