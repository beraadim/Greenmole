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

// Modified for Greenmole by its maintainers.

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources, eventBus, fakeClock, directiveFixture } = require('./helpers/client-fixtures');

function fixture({ visualViewport = true } = {}) {
    const clock = fakeClock();
    const keyboardCallbacks = new Set();
    const native = {
        enabled: false,
        focused: false,
        subscribe(callback) {
            keyboardCallbacks.add(callback);
            return () => keyboardCallbacks.delete(callback);
        }
    };
    const window = Object.assign(clock.window, {
        innerWidth: 1024, innerHeight: 768,
        pageXOffset: 0, pageYOffset: 0,
        requestAnimationFrame: callback => clock.window.setTimeout(callback, 16),
        cancelAnimationFrame: id => clock.window.clearTimeout(id)
    });
    const visualClock = fakeClock();
    if (visualViewport)
        window.visualViewport = Object.assign(visualClock.window, {
            width: 1024, height: 768, pageLeft: 0, pageTop: 0, scale: 1
        });
    const loaded = sources(['client/services/guacViewportService.js',
        'client/directives/guacViewport.js']);
    const service = loaded.factories.guacViewportService(window, native);
    const scope = eventBus();
    const scrolls = [];
    window.scrollTo = (...args) => scrolls.push(args);
    const element = { style: {}, scrollLeft: 0, scrollTop: 0 };
    const services = { $window: window, guacViewportService: service };
    loaded.directives.guacViewport.controller.at(-1)(scope,
        { get: name => services[name] }, { find: () => [element] });
    return {
        clock, window, native, service, scope, element, scrolls, visualClock,
        keyboardCallbacks,
        keyboard(properties) {
            Object.assign(native, properties);
            [...keyboardCallbacks].forEach(callback => callback());
        },
        visible(properties, event = 'resize') {
            if (window.visualViewport) {
                Object.assign(window.visualViewport, properties);
                visualClock.emit(event);
            }
            else {
                if ('height' in properties) window.innerHeight = properties.height;
                if ('width' in properties) window.innerWidth = properties.width;
                clock.emit(event);
            }
            clock.advance(16);
        }
    };
}

test('viewport initializes synchronously and uses events without idle polling', () => {
    const f = fixture();
    assert.equal(f.element.style.width, '1024px');
    assert.equal(f.element.style.height, '768px');
    assert.equal(f.clock.timers.size, 0);
    f.window.innerHeight = 900;
    f.clock.emit('resize');
    f.clock.emit('resize');
    assert.equal(f.clock.timers.size, 1);
    f.clock.advance(16);
    assert.equal(f.element.style.height, '900px');
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.keyboardCallbacks.size, 1);
});

test('native keyboard fits locally while remote height remains stable through blur and dismissal', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    for (const height of [700, 600, 420]) {
        f.visible({ height, pageTop: 30 });
        assert.equal(f.element.style.height, height + 'px');
        assert.equal(f.element.style.top, '30px');
        assert.deepEqual({ ...f.service.getRemoteSize(1024, height - 44) },
            { width: 1024, height: 724 });
    }
    f.keyboard({ focused: false });
    assert.equal(f.service.getRemoteSize(1024, 376).height, 724);
    f.clock.advance(5000);
    assert.equal(f.service.getRemoteSize(1024, 376).height, 724);
    assert.equal(f.clock.timers.size, 0, 'a still-short viewport must not start a timer loop');
    for (const height of [500, 710, 768]) {
        f.visible({ height, pageTop: 0 });
        assert.equal(f.service.getRemoteSize(1024, height - 44).height, 724);
    }
    assert.equal(f.element.style.height, '768px');
    f.clock.advance(500);
    assert.equal(f.clock.timers.size, 0);
});

test('disabling native mode holds the inset until the keyboard finishes closing', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400, pageTop: 20 });
    f.keyboard({ enabled: false, focused: false });
    assert.equal(f.element.style.height, '400px');
    assert.equal(f.service.getRemoteSize(1024, 400).height, 768);
    f.visible({ height: 768, pageTop: 0 });
    assert.equal(f.service.getRemoteSize(1024, 768).height, 768);
    assert.equal(f.element.style.left, '');
    assert.equal(f.element.style.top, '');
    assert.equal(f.element.style.right, '');
    assert.equal(f.clock.timers.size, 0);
});

test('a small browser chrome difference settles only after the hide animation is quiet', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400 });
    f.keyboard({ focused: false });
    f.visible({ height: 740 });
    assert.equal(f.service.getRemoteSize(1024, 740).height, 768);
    f.clock.advance(249);
    assert.equal(f.service.getRemoteSize(1024, 740).height, 768);
    f.clock.advance(1);
    assert.equal(f.service.getRemoteSize(1024, 740).height, 740);
    assert.equal(f.clock.timers.size, 0);
});

test('rotation and multitasking rebase the held remote layout instead of retaining portrait geometry', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400 });
    f.window.innerWidth = 1366;
    f.window.innerHeight = 1024;
    f.visible({ width: 1366, height: 600 });
    assert.equal(f.element.style.width, '1366px');
    assert.equal(f.element.style.height, '600px');
    assert.deepEqual({ ...f.service.getRemoteSize(1366, 556) },
        { width: 1366, height: 980 });
    f.window.innerWidth = 800;
    f.window.innerHeight = 1024;
    f.visible({ width: 800, height: 600 });
    assert.deepEqual({ ...f.service.getRemoteSize(800, 556) },
        { width: 800, height: 980 });
});

test('tiled desktops receive their row share of keyboard occlusion', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400 });
    assert.deepEqual({ ...f.service.getRemoteSize(512, 158, 2) },
        { width: 512, height: 342 });
    assert.deepEqual({ ...f.service.getRemoteSize(512, 69, 4) },
        { width: 512, height: 161 });
});

test('browser pinch zoom and pan do not resize or reposition the desktop', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400, pageTop: 10 });
    const style = { ...f.element.style };
    f.visible({ width: 512, height: 200, pageLeft: 150, pageTop: 250, scale: 2 });
    assert.deepEqual(f.element.style, style);
    assert.equal(f.service.getRemoteSize(1024, 400).height, 768);
    f.visible({ pageLeft: 200, pageTop: 300 }, 'scroll');
    assert.deepEqual(f.element.style, style);
    assert.deepEqual(f.scrolls, []);
    f.visible({ width: 1024, height: 400, pageLeft: 0, pageTop: 10, scale: 1 });
    assert.deepEqual(f.element.style, style);
});

test('browsers without VisualViewport preserve resolution when innerHeight shrinks for the keyboard', () => {
    const f = fixture({ visualViewport: false });
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400 });
    assert.equal(f.element.style.height, '400px');
    assert.equal(f.service.getRemoteSize(1024, 400).height, 768);
    f.keyboard({ focused: false });
    f.visible({ height: 768 });
    assert.equal(f.service.getRemoteSize(1024, 768).height, 768);
});

test('destroy removes viewport and focus listeners and cancels pending frames and settle timers', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true });
    f.visible({ height: 400 });
    f.keyboard({ focused: false });
    assert.equal(f.clock.timers.size, 1);
    f.visualClock.emit('resize');
    assert.equal(f.clock.timers.size, 1);
    f.scope.$broadcast('$destroy');
    assert.equal(f.keyboardCallbacks.size, 0);
    for (const events of [f.clock.events, f.visualClock.events])
        for (const callbacks of events.values()) assert.equal(callbacks.size, 0);
    assert.equal(f.clock.timers.size, 0);
    f.clock.advance(5000);
    assert.equal(f.clock.timers.size, 0);
});

test('actual client directive does not request remote resizes during native keyboard show or hide', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 724;
    client.scope.mainElementResized();
    client.clock.advance(150);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 724]]);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 724;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    for (const height of [600, 400]) {
        f.visible({ height });
        client.main.offsetHeight = height - 44;
        client.scope.mainElementResized();
        client.clock.advance(200);
    }
    f.keyboard({ focused: false });
    for (const height of [500, 700, 768]) {
        f.visible({ height });
        client.main.offsetHeight = height - 44;
        client.scope.mainElementResized();
        client.clock.advance(200);
    }
    client.clock.advance(5000);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 724]]);
    assert.deepEqual(client.connections, [['first', 1024, 724]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('fractional keyboard heights never resize an actual client in a multi-row grid', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 512;
    client.main.closest = () => ({ children: [{}, {}] });
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => Math.round((parseFloat(f.element.style.height) - 44) / 2 - 20)
    });
    client.scope.mainElementResized();
    client.clock.advance(150);
    assert.deepEqual(client.sent, [['first', 'size', 512, 342]]);
    client.displays.at(-1).getWidth = () => 512;
    client.displays.at(-1).getHeight = () => 342;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    for (const height of [700.25, 601.5, 447.25, 400.75]) {
        f.visible({ height });
        client.clock.advance(500);
    }
    f.keyboard({ focused: false });
    for (const height of [500.25, 700.75, 768]) {
        f.visible({ height });
        client.clock.advance(200);
    }
    client.clock.advance(5000);
    assert.deepEqual(client.sent, [['first', 'size', 512, 342]]);
    assert.deepEqual(client.connections, [['first', 512, 342]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
    assert.equal(f.clock.timers.size, 0);
});

test('a settled inset change reaches the actual client even when DOM dimensions do not change', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => Math.round(parseFloat(f.element.style.height) - 44)
    });
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 724;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    f.visible({ height: 400 });
    f.keyboard({ focused: false });
    f.visible({ height: 740 });
    client.clock.advance(1000);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 724]]);
    f.clock.advance(250);
    client.clock.advance(150);
    assert.deepEqual(client.sent, [
        ['first', 'size', 1024, 724],
        ['first', 'size', 1024, 696]
    ]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
    assert.equal(f.clock.timers.size, 0);
});


test('a queued viewport digest callback does no work after client destruction', () => {
    const f = fixture();
    const queued = [];
    const client = directiveFixture({ viewportService: f.service,
        evalAsync: callback => queued.push(callback), state: 'IDLE' });
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 768;
    let lateResizeCalls = 0;
    const resize = client.scope.mainElementResized;
    client.scope.mainElementResized = () => { lateResizeCalls++; resize(); };
    client.scope.$broadcast('$destroy');
    while (queued.length)
        queued.shift()();
    assert.equal(lateResizeCalls, 0);
    assert.deepEqual(client.connections, []);
    f.scope.$broadcast('$destroy');
    assert.equal(f.keyboardCallbacks.size, 0);
    assert.equal(f.clock.timers.size, 0);
});
