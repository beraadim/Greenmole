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
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the production Angular factories/controllers with their public
// event dependencies. No browser input, clipboard, or remote session is used.
function sources(files, globals = {}) {
    const factories = {};
    const directives = {};
    const module = {
        factory(name, definition) { factories[name] = definition.at(-1); return this; },
        directive(name, definition) { directives[name] = definition.at(-1)(); return this; }
    };
    const context = vm.createContext({
        angular: { module: () => module, noop() {} },
        setTimeout() { throw new Error('Input must not poll or allocate timers'); },
        ...globals
    });
    for (const file of files)
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/app', file), 'utf8'), context);
    return { factories, directives };
}

function queue() {
    const types = sources(['client/types/ClientInputQueue.js']);
    return new (types.factories.ClientInputQueue())();
}

function eventBus() {
    const listeners = new Map();
    return {
        $on(name, callback) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(callback);
            return () => listeners.get(name).delete(callback);
        },
        $broadcast(name, ...args) {
            const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
            for (const callback of [...(listeners.get(name) || [])]) callback(event, ...args);
            return event;
        },
        count(name) { return (listeners.get(name) || new Set()).size; }
    };
}

class InputDevice {
    active = new Map();
    on(name, callback) {
        if (!this.active.has(name)) this.active.set(name, new Set());
        this.active.get(name).add(callback);
    }
    onEach(names, callback) { names.forEach(name => this.on(name, callback)); }
    off(name, callback) {
        const callbacks = this.active.get(name);
        if (callbacks) callbacks.delete(callback);
    }
    offEach(names, callback) { names.forEach(name => this.off(name, callback)); }
    setCursor() { return false; }
    emit(event) { for (const callback of [...(this.active.get(event.type) || [])]) callback(event); }
}

function directiveFixture({ blocked = false, root = eventBus(), clipboardService } = {}) {
    const scope = eventBus();
    const watches = new Map();
    let touchBehaviorChanged;
    scope.$watch = (expression, callback) => watches.set(expression, callback);
    scope.$watchGroup = (expressions, callback) => { touchBehaviorChanged = callback; };
    scope.$evalAsync = () => {};
    const sent = [];
    const cursor = [];
    const displays = [];
    function managed(name) {
        const display = {
            scale() {}, getScale: () => 2,
            getWidth: () => 1920, getHeight: () => 1080,
            getElement: () => ({}),
            showCursor: visible => cursor.push(['visible', visible]),
            moveCursor: (x, y) => cursor.push([x, y])
        };
        displays.push(display);
        return {
            id: name,
            clientProperties: { focused: true, scale: 2 },
            client: {
                getDisplay: () => display,
                sendMouseState: state => sent.push([name, 'mouse', state.x, state.y,
                    !!state.left, !!state.middle, !!state.right, !!state.up, !!state.down]),
                sendKeyEvent: (pressed, keysym) => sent.push([name, 'key', pressed, keysym]),
                sendTouchState: state => sent.push([name, 'touch', state.x, state.y, state.force]),
                sendSize() {}
            }
        };
    }
    const mouse = new InputDevice();
    const touchscreen = new InputDevice();
    const touchpad = new InputDevice();
    const touch = new InputDevice();
    const main = { addEventListener() {}, style: {}, offsetWidth: 0, offsetHeight: 0,
        scrollLeft: 0, scrollTop: 0 };
    const container = { appendChild() {}, offsetLeft: 0, offsetTop: 0 };
    const element = { 0: main, find: () => [container] };
    const loaded = sources(['client/types/ClientInputQueue.js', 'client/directives/guacClient.js'], {
        document: { body: { focus() {} } },
        Guacamole: {
            Mouse: Object.assign(function() { return mouse; }, {
                Touchscreen: function() { return touchscreen; },
                Touchpad: function() { return touchpad; }
            }),
            Touch: function() { return touch; }
        }
    });
    const services = {
        ManagedClient: { connect() {}, setClipboard: (target, data) => sent.push([target.id, 'clipboard', data.data]) },
        ClientInputQueue: loaded.factories.ClientInputQueue(),
        $rootScope: root, $window: {},
        clipboardService: clipboardService || { isSyncInProgress: () => blocked }
    };
    scope.client = managed('first');
    const definition = loaded.directives.guacClient.controller;
    definition.at(-1)(scope, { get: name => services[name] }, element);
    const attach = value => { scope.client = value; watches.get('client')(value); };
    attach(scope.client);
    return { root, scope, sent, cursor, mouse, touch, touchpad, touchscreen,
        attach, managed, services, displays, configureTouch: () => touchBehaviorChanged() };
}

function mouseEvent(type, x, flags = {}) {
    return { type, state: { x, y: 20, ...flags }, stopPropagation() {}, preventDefault() {} };
}

function deferred() {
    const result = {};
    result.promise = new Promise((resolve, reject) => Object.assign(result, { resolve, reject }));
    return result;
}

function clipboardFixture() {
    const root = eventBus();
    const reads = [];
    const writes = [];
    const state = [];
    root.$on('clipboardSyncInProgress', (event, active) => state.push(active));
    const clipboard = {
        readText() { const read = deferred(); reads.push(read); return read.promise; },
        writeText(text) { writes.push(text); return Promise.resolve(); }
    };
    const window = { document: { createElement: () => ({ addEventListener() {} }), body: { appendChild() {} } } };
    const services = {
        $q: { defer: deferred }, $window: window, $rootScope: root,
        ClipboardData: function(data) { Object.assign(this, data); },
        sessionStorageFactory: { create: initial => {
            let stored = initial;
            return value => { if (value !== undefined) stored = value; return stored; };
        } }
    };
    const loaded = sources(['clipboard/services/clipboardService.js'], { navigator: { clipboard } });
    const service = loaded.factories.clipboardService({ get: name => services[name] });
    return { service, reads, writes, state, root };
}

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
    // The service's own test listener is the only remaining subscription.
    assert.equal(clipboard.root.count('clipboardSyncInProgress'), 1);
});

test('overlapping resync operations keep the gate closed until both local reads complete', async () => {
    const fixture = clipboardFixture();
    const first = fixture.service.resyncClipboard();
    const second = fixture.service.resyncClipboard();
    assert.deepEqual(fixture.state, [true]);
    fixture.reads[0].resolve('first');
    await first;
    assert.equal(fixture.service.isSyncInProgress(), true);
    assert.deepEqual(fixture.state, [true]);
    fixture.reads[1].resolve('second');
    await second;
    assert.equal(fixture.service.isSyncInProgress(), false);
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
