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

function fixture({ visualViewport = true, nativeState = {}, visualState = {} } = {}) {
    const clock = fakeClock();
    const keyboardCallbacks = new Set();
    const native = {
        enabled: false,
        focused: false,
        toolbarHeight: 44,
        subscribe(callback) {
            keyboardCallbacks.add(callback);
            return () => keyboardCallbacks.delete(callback);
        },
        ...nativeState
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
            width: 1024, height: 768, pageLeft: 0, pageTop: 0, scale: 1,
            ...visualState
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

test('native keyboard limits the visible area while remote height remains stable through blur and dismissal', () => {
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
    f.clock.advance(16);
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
    f.clock.advance(16);
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

test('already-pinched native mode initializes a usable layout and only toolbar changes resize it', () => {
    const f = fixture({ nativeState: { enabled: true, focused: true, toolbarHeight: 48 },
        visualState: { width: 512, height: 384, scale: 2, pageLeft: 100, pageTop: 50 } });
    assert.equal(f.element.style.width, '1024px');
    assert.equal(f.element.style.height, '768px');
    const style = { ...f.element.style };
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => 768 - f.native.toolbarHeight
    });
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 720;
    client.watches.get('client.managedDisplay.size')();
    assert.equal(client.container.style.paddingBottom, undefined);
    const states = [];
    const stop = f.service.subscribe(state => states.push({ ...state }));

    f.keyboard({ panning: true, toolbarHeight: 96 });
    assert.equal(states.at(-1).panning, true);
    assert.equal(client.container.style.paddingBottom, undefined);
    f.visible({ width: 400, height: 300, pageLeft: 200, pageTop: 100 });
    client.clock.advance(500);
    assert.deepEqual(f.element.style, style);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 720], ['first', 'size', 1024, 672]]);
    assert.deepEqual(client.connections, [['first', 1024, 720]]);
    stop();
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
    assert.equal(f.clock.timers.size, 0);
});

test('native controls still publish while a pinched keyboard view retains its last unzoomed geometry', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true, toolbarHeight: 48 });
    f.visible({ height: 400, pageTop: 10 });
    const style = { ...f.element.style };
    f.visible({ width: 512, height: 200, scale: 2, pageLeft: 50, pageTop: 80 });
    const states = [];
    const stop = f.service.subscribe(state => states.push({ ...state }));
    f.keyboard({ panning: true, toolbarHeight: 96 });
    assert.equal(states.at(-1).panning, true);
    assert.equal(states.at(-1).toolbarHeight, 96);
    assert.equal(states.at(-1).keyboardInset, 368);
    assert.deepEqual(f.element.style, style);
    assert.deepEqual({ ...f.service.getRemoteSize(1024, 400) }, { width: 1024, height: 768 });
    stop();
    f.scope.$broadcast('$destroy');
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

test('native keyboard preserves auto-fit scale and enables scrolling instead of shrinking the desktop', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    const display = client.displays.at(-1);
    display.getWidth = () => 1024;
    display.getHeight = () => 724;
    client.scope.client.clientProperties.autoFit = true;
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 724;
    client.scope.mainElementResized();
    client.watches.get('client.clientProperties.scale')(client.scope.client.clientProperties.scale);
    client.clock.advance(150);
    assert.equal(display.getScale(), 1);
    assert.equal(client.main.style.overflow, 'hidden');

    f.keyboard({ focused: true });
    assert.equal(client.main.style.overflow, 'auto');
    for (const height of [600, 400]) {
        f.visible({ height });
        client.main.offsetHeight = height - 44;
        client.scope.mainElementResized();
        client.watches.get('client.clientProperties.scale')(client.scope.client.clientProperties.scale);
        client.clock.advance(200);
        assert.equal(client.scope.client.clientProperties.minScale, 1);
        assert.equal(display.getScale(), 1);
        assert.equal(client.main.style.overflow, 'auto');
    }
    f.keyboard({ focused: false });
    assert.equal(client.main.style.overflow, 'auto',
        'the desktop remains scrollable throughout keyboard dismissal');
    f.visible({ height: 768 });
    client.main.offsetHeight = 724;
    client.scope.mainElementResized();
    client.watches.get('client.clientProperties.scale')(client.scope.client.clientProperties.scale);
    f.clock.advance(16);
    client.clock.advance(500);
    assert.equal(display.getScale(), 1);
    assert.equal(client.main.style.overflow, 'hidden');
    assert.deepEqual(client.sent, [['first', 'size', 1024, 724]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('focus freezes remote geometry before the keyboard inset or visual viewport has caught up', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 724;
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 724;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    // Safari can resize the layout before reporting the first keyboard inset.
    client.main.offsetHeight = 600;
    client.scope.mainElementResized();
    client.clock.advance(500);
    // Its visible width can also briefly differ from the layout width. This
    // is not a rotation or a request to change the remote desktop resolution.
    f.visible({ width: 1000, height: 400 });
    client.main.offsetWidth = 1000;
    client.main.offsetHeight = 356;
    client.scope.mainElementResized();
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 724]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('native controls resize the usable desktop once and software keyboard opening and closing preserve its size and zoom', () => {
    const f = fixture();
    const client = directiveFixture({ viewportService: f.service });
    const display = client.displays.at(-1);
    display.getWidth = () => 1024;
    let remoteHeight = 768;
    display.getHeight = () => remoteHeight;
    client.main.offsetWidth = 1024;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => Math.round(parseFloat(f.element.style.height)
            - (f.native.enabled ? f.native.toolbarHeight : 0))
    });
    client.scope.mainElementResized();
    client.scope.client.clientProperties.autoFit = false;
    client.scope.client.clientProperties.scale = 1.75;
    client.watches.get('client.clientProperties.scale')(1.75);
    client.clock.advance(150);
    client.watches.get('client.managedDisplay.size')();

    f.keyboard({ enabled: true, toolbarHeight: 0 });
    f.keyboard({ toolbarHeight: 48 });
    assert.equal(client.container.style.paddingBottom, undefined);
    client.clock.advance(500);
    remoteHeight = 720;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    for (const height of [600.25, 400.75]) {
        f.visible({ height });
        client.scope.mainElementResized();
        client.watches.get('client.clientProperties.scale')(client.scope.client.clientProperties.scale);
        client.clock.advance(500);
        assert.equal(display.getScale(), 1.75);
        assert.equal(client.scope.client.clientProperties.minScale, 1);
    }
    f.keyboard({ focused: false });
    f.visible({ height: 768 });
    f.clock.advance(500);
    client.clock.advance(500);
    assert.equal(display.getScale(), 1.75);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 768], ['first', 'size', 1024, 720]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('a remembered native mode connects above the measured controls and rebases wrapped toolbar height once', () => {
    const f = fixture();
    f.keyboard({ enabled: true, focused: true, toolbarHeight: 96 });
    f.visible({ height: 400 });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => 400 - f.native.toolbarHeight
    });
    client.scope.mainElementResized();
    client.clock.advance(150);
    assert.deepEqual(client.connections, [['first', 1024, 672]]);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 672]]);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 672;
    client.watches.get('client.managedDisplay.size')();
    assert.equal(client.container.style.paddingBottom, undefined);
    f.keyboard({ toolbarHeight: 48 });
    assert.equal(client.container.style.paddingBottom, undefined);
    client.clock.advance(500);
    assert.deepEqual(client.connections, [['first', 1024, 672]]);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 672], ['first', 'size', 1024, 720]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('remembered native mode waits for the measured toolbar before its first handshake and applies DPR once', () => {
    const f = fixture({ nativeState: { enabled: true, toolbarHeight: 0 } });
    const client = directiveFixture({ viewportService: f.service, density: 1.25 });
    client.main.offsetWidth = 1024;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => Math.round(parseFloat(f.element.style.height) - f.native.toolbarHeight)
    });
    client.scope.mainElementResized();
    client.clock.advance(1000);
    assert.deepEqual(client.connections, []);
    assert.deepEqual(client.sent, []);

    f.keyboard({ toolbarHeight: 48 });
    client.clock.advance(150);
    assert.deepEqual(client.connections, [['first', 1024, 720]]);
    assert.deepEqual(client.sent, [['first', 'size', 1280, 900]]);
    const display = client.displays.at(-1);
    display.getWidth = () => 1280;
    display.getHeight = () => 900;
    client.scope.client.clientProperties.autoFit = true;
    client.watches.get('client.managedDisplay.size')();
    client.watches.get('client.clientProperties.scale')(client.scope.client.clientProperties.scale);
    assert.equal(display.getScale(), 0.8);
    f.keyboard({ focused: true });
    for (const height of [600.25, 400.75]) {
        f.visible({ height });
        client.scope.mainElementResized();
        client.watches.get('client.clientProperties.scale')(client.scope.client.clientProperties.scale);
        client.clock.advance(500);
        assert.equal(display.getScale(), 0.8);
    }
    f.keyboard({ focused: false });
    f.visible({ height: 768 });
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1280, 900]]);
    assert.equal(client.container.style.paddingBottom, undefined);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('wrapped controls change only their row share of each tiled desktop during software keyboard occlusion', () => {
    const f = fixture({ nativeState: { enabled: true, toolbarHeight: 48 } });
    const client = directiveFixture({ viewportService: f.service, density: 2 });
    const row = { children: [{}] };
    const grid = { children: [row, {}] };
    client.main.closest = selector => selector === '.tiled-client-grid' ? grid : row;
    client.main.offsetWidth = 512;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => Math.round((parseFloat(f.element.style.height) - f.native.toolbarHeight) / 2 - 20)
    });
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 680;
    client.watches.get('client.managedDisplay.size')();
    assert.deepEqual(client.connections, [['first', 512, 340]]);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 680]]);
    f.keyboard({ focused: true });
    f.visible({ height: 400 });
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 680]]);
    f.keyboard({ toolbarHeight: 96 });
    client.clock.advance(150);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 680], ['first', 'size', 1024, 632]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('native mode removal restores the full viewport once controls have left the layout', () => {
    const f = fixture({ nativeState: { enabled: true, toolbarHeight: 48 } });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 720;
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 720;
    client.watches.get('client.managedDisplay.size')();
    // Protect against an intermediate layout during Angular mode teardown.
    f.keyboard({ enabled: false });
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 720]]);
    client.main.offsetHeight = 768;
    client.scope.mainElementResized();
    f.clock.advance(16);
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 720], ['first', 'size', 1024, 768]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('a genuine layout width change rebases an actual native client while keyboard viewport changes do not', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 768;
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 768;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    f.visible({ height: 400 });
    client.main.offsetHeight = 400;
    client.scope.mainElementResized();
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 768]]);

    f.window.innerWidth = 1366;
    f.window.innerHeight = 1024;
    client.main.offsetWidth = 1366;
    client.main.offsetHeight = 600;
    f.visible({ width: 1366, height: 600 });
    client.clock.advance(500);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 768],
        ['first', 'size', 1366, 1024]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('changing tile columns rebases native desktop width without treating keyboard animation as a layout change', () => {
    const f = fixture();
    f.keyboard({ enabled: true });
    const client = directiveFixture({ viewportService: f.service });
    const row = { children: [{}] };
    const grid = { children: [row] };
    client.main.closest = selector => selector === '.tiled-client-grid' ? grid : row;
    client.main.offsetWidth = 1024;
    client.main.offsetHeight = 768;
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 768;
    client.watches.get('client.managedDisplay.size')();
    f.keyboard({ focused: true });
    f.visible({ height: 400 });
    client.main.offsetHeight = 400;
    client.scope.mainElementResized();
    client.clock.advance(500);
    row.children.push({});
    client.main.offsetWidth = 512;
    client.scope.mainElementResized();
    client.clock.advance(150);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 768],
        ['first', 'size', 512, 768]]);
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

test('a real unoccluded height-only resize updates the usable native desktop', () => {
    const f = fixture({ nativeState: { enabled: true, toolbarHeight: 48 } });
    const client = directiveFixture({ viewportService: f.service });
    client.main.offsetWidth = 1024;
    Object.defineProperty(client.main, 'offsetHeight', {
        get: () => Math.round(parseFloat(f.element.style.height) - 48)
    });
    client.scope.mainElementResized();
    client.clock.advance(150);
    client.displays.at(-1).getWidth = () => 1024;
    client.displays.at(-1).getHeight = () => 720;
    client.watches.get('client.managedDisplay.size')();
    f.window.innerHeight = 900;
    f.visible({ height: 900 });
    client.clock.advance(150);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 720], ['first', 'size', 1024, 852]]);
    client.scope.$broadcast('$destroy');
    f.scope.$broadcast('$destroy');
});

test('a settled Safari chrome change updates the native desktop only after software keyboard dismissal completes', () => {
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
    f.clock.advance(16);
    client.clock.advance(150);
    assert.deepEqual(client.sent, [['first', 'size', 1024, 724], ['first', 'size', 1024, 696]]);
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
