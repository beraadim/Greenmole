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

const fs = require('node:fs');
const path = require('node:path');
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
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/app', file), 'utf8'), context);
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

function directiveFixture({ blocked = false, root = eventBus(), clipboardService,
        clock = fakeClock(), state = 'CONNECTED', protocol = 'rdp', density = 1 } = {}) {
    const scope = eventBus();
    const watches = new Map();
    let touchBehaviorChanged;
    scope.$watch = (expression, callback) => watches.set(expression, callback);
    scope.$watchGroup = (expressions, callback) => { touchBehaviorChanged = callback; };
    scope.$evalAsync = callback => callback();
    const sent = [];
    const cursor = [];
    const displays = [];
    function managed(name) {
        let scale = 2;
        const display = {
            scale(value) { scale = value; }, getScale: () => scale,
            getWidth: () => 1920, getHeight: () => 1080,
            getElement: () => ({}),
            showCursor: visible => cursor.push(['visible', visible]),
            moveCursor: (x, y) => cursor.push([x, y])
        };
        displays.push(display);
        return {
            id: name,
            protocol,
            clientState: { connectionState: state },
            clientProperties: { focused: true, scale: 2 },
            client: {
                getDisplay: () => display,
                sendMouseState: state => sent.push([name, 'mouse', state.x, state.y,
                    !!state.left, !!state.middle, !!state.right, !!state.up, !!state.down]),
                sendKeyEvent: (pressed, keysym) => sent.push([name, 'key', pressed, keysym]),
                sendTouchState: state => sent.push([name, 'touch', state.x, state.y, state.force]),
                sendSize: (width, height) => sent.push([name, 'size', width, height])
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
    const loaded = sources(['client/types/ClientInputQueue.js', 'client/types/ClientResizeQueue.js',
        'client/types/ManagedClientState.js', 'client/directives/guacClient.js'], {
        document: { body: { focus() {} } },
        Guacamole: {
            Mouse: Object.assign(function() { return mouse; }, {
                Touchscreen: function() { return touchscreen; },
                Touchpad: function() { return touchpad; }
            }),
            Touch: function() { return touch; }
        }
    });
    const connections = [];
    const services = {
        ManagedClient: { connect: (target, width, height) => connections.push([target.id, width, height]),
            setClipboard: (target, data) => sent.push([target.id, 'clipboard', data.data]) },
        ManagedClientState: loaded.factories.ManagedClientState(),
        ClientInputQueue: loaded.factories.ClientInputQueue(),
        ClientResizeQueue: loaded.factories.ClientResizeQueue(clock.window),
        $rootScope: root, $window: Object.assign(clock.window, { devicePixelRatio: density }),
        clipboardService: clipboardService || { isSyncInProgress: () => blocked }
    };
    scope.client = managed('first');
    const definition = loaded.directives.guacClient.controller;
    definition.at(-1)(scope, { get: name => services[name] }, element);
    const attach = value => { scope.client = value; watches.get('client')(value); };
    attach(scope.client);
    return { root, scope, sent, cursor, mouse, touch, touchpad, touchscreen,
        attach, managed, services, displays, main, watches, clock, connections,
        configureTouch: () => touchBehaviorChanged() };
}

function fakeClock() {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    const events = new Map();
    const window = {
        performance: { now: () => now },
        setTimeout(callback, delay) {
            const id = ++nextId;
            timers.set(id, { at: now + delay, callback });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(name, callback) {
            if (!events.has(name)) events.set(name, new Set());
            events.get(name).add(callback);
        },
        removeEventListener(name, callback) { events.get(name)?.delete(callback); }
    };
    return { window, timers, events, now: () => now,
        advance(delay) {
            const until = now + delay;
            for (let steps = 0; ; steps++) {
                if (steps > 10000) throw new Error('Resize timer failed to quiesce');
                const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
                if (!timer || timer.at > until) break;
                timers.delete(id);
                now = timer.at;
                timer.callback();
            }
            now = until;
        },
        emit(name) { for (const callback of [...(events.get(name) || [])]) callback(); }
    };
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
    return { service, reads, writes, state, root, clipboard };
}

module.exports = { sources, queue, eventBus, directiveFixture, mouseEvent, deferred, clipboardFixture, fakeClock };
