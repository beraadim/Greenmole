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
const { sources, eventBus } = require('./helpers/client-fixtures');

function keyboardService(navigator = {}) {
    return sources(['textInput/services/guacNativeKeyboard.js'])
        .factories.guacNativeKeyboard({ navigator });
}

function textInputFixture({ native = true, resizeObserver = true } = {}) {
    const service = keyboardService();
    service.setEnabled(native);
    const scope = eventBus();
    const watches = new Map();
    scope.nativeKeyboard = native;
    scope.$evalAsync = callback => callback();
    scope.$apply = callback => callback();
    scope.$watch = (expression, callback) => watches.set(expression, callback);
    const root = eventBus();
    const sent = [];
    root.$on('guacSyntheticKeydown', (event, keysym) => sent.push(['down', keysym]));
    root.$on('guacSyntheticKeyup', (event, keysym) => sent.push(['up', keysym]));
    const listeners = new Map();
    let focusCalls = 0;
    let insideGesture = false;
    const focusGestures = [];
    const focusPanning = [];
    const target = {
        value: '', selectionStart: 0,
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) {
            assert.equal(listeners.get(name), listener);
            listeners.delete(name);
        },
        setSelectionRange(start) { this.selectionStart = start; },
        focus(options) {
            focusCalls++;
            focusGestures.push(insideGesture);
            focusPanning.push(service.panning);
            if (this.onfocus) this.onfocus();
        },
        blur() { if (this.onblur) this.onblur(); }
    };
    const toolbar = { height: 44, getBoundingClientRect() { return { height: this.height }; } };
    const observers = new Set();
    const frames = new Map();
    const windowListeners = new Map();
    let nextFrame = 0;
    const window = {
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; observers.add(this); }
            observe(element) { assert.equal(element, toolbar); }
            disconnect() { observers.delete(this); }
        },
        requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        addEventListener(name, callback) { windowListeners.set(name, callback); },
        removeEventListener(name, callback) {
            assert.equal(windowListeners.get(name), callback);
            windowListeners.delete(name);
        }
    };
    if (!resizeObserver)
        delete window.ResizeObserver;
    const timeouts = [];
    const loaded = sources(['textInput/directives/guacTextInput.js']);
    loaded.directives.guacTextInput.controller.at(-1)(scope, root,
        { 0: toolbar, find: () => [target] }, callback => timeouts.push(callback), service, window);
    return {
        scope, target, service, sent, watches, listeners, timeouts, focusGestures, focusPanning,
        toolbar, observers, frames, windowListeners,
        flushFrames() {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(callback => callback());
        },
        resizeToolbar(height) {
            toolbar.height = height;
            [...observers].forEach(observer => observer.callback());
        },
        get focusCalls() { return focusCalls; },
        gesture(method) {
            insideGesture = true;
            scope[method]({ preventDefault() {} });
            insideGesture = false;
        },
        show() { this.gesture('showNativeKeyboard'); },
        hide() { this.gesture('hideNativeKeyboard'); },
        event(name) { listeners.get(name)({ preventDefault() {} }); },
        text(text) {
            target.value = '\u200B'.repeat(4) + text + '\u200B'.repeat(4);
            target.selectionStart = 4 + text.length;
            listeners.get('input')({ preventDefault() {} });
        }
    };
}

test('iPad detection includes desktop browsing mode and leaves non-iPad devices alone', () => {
    assert.equal(keyboardService({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }).isIPad, true);
    assert.equal(keyboardService({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }).isIPad, true);
    assert.equal(keyboardService({ platform: 'MacIntel', maxTouchPoints: 0 }).isIPad, false);
    assert.equal(keyboardService({ platform: 'Win32', maxTouchPoints: 10 }).isIPad, false);
    assert.equal(keyboardService({ userAgent: 'iPhone', maxTouchPoints: 5 }).isIPad, false);
    assert.equal(keyboardService().enabled, false);
});

test('keyboard state subscriptions report intent, reset on disable and cleanly unsubscribe', () => {
    const service = keyboardService();
    const states = [];
    const unsubscribe = service.subscribe(() => states.push([service.enabled, service.focused]));
    service.setFocused(true);
    service.setEnabled(true);
    service.setEnabled(true);
    service.setFocused(true);
    service.setFocused(true);
    service.setEnabled(false);
    unsubscribe();
    unsubscribe();
    service.setEnabled(true);
    assert.deepEqual(states, [[true, false], [true, true], [false, false]]);
});

test('native mode never auto-focuses, uses the same mounted editor synchronously and does not reopen after blur', () => {
    const fixture = textInputFixture();
    assert.equal(fixture.focusCalls, 0);
    assert.equal(fixture.service.focused, false);
    fixture.show();
    assert.equal(fixture.focusCalls, 1);
    assert.equal(fixture.service.focused, true);
    assert.deepEqual(fixture.focusGestures, [true]);
    assert.equal(fixture.timeouts.length, 0);
    fixture.hide();
    assert.equal(fixture.service.focused, false);
    fixture.target.blur();
    fixture.watches.get('nativeKeyboard')(true);
    assert.equal(fixture.focusCalls, 1);
    fixture.show();
    assert.equal(fixture.focusCalls, 2);
    assert.deepEqual(fixture.focusGestures, [true, true]);
});

test('Show explicitly reopens after OS keyboard dismissal leaves the editor focused', () => {
    const fixture = textInputFixture();
    fixture.show();
    fixture.show();
    assert.equal(fixture.focusCalls, 2);
    assert.deepEqual(fixture.focusGestures, [true, true]);
    assert.equal(fixture.service.focused, true);
});

test('native text input sends Unicode codepoints once without echoing passwords in a history', () => {
    const fixture = textInputFixture();
    fixture.show();
    fixture.text('Aé😀\n');
    assert.deepEqual(fixture.sent, [
        ['down', 65], ['up', 65], ['down', 233], ['up', 233],
        ['down', 0x0101F600], ['up', 0x0101F600], ['down', 0xFF0D], ['up', 0xFF0D]
    ]);
    assert.equal(fixture.target.value, '\u200B'.repeat(8));
    assert.equal(fixture.target.selectionStart, 4);
    assert.equal(fixture.scope.sentText.length, 0);
    assert.equal(fixture.timeouts.length, 0);
});

test('IME completion before or after final input produces exactly one character in both modes', () => {
    for (const native of [true, false]) {
        const fixture = textInputFixture({ native });
        if (native) fixture.show();
        fixture.event('compositionstart');
        fixture.text('日');
        assert.deepEqual(fixture.sent, []);
        fixture.show(); // A Show tap must never interrupt ongoing composition.
        assert.equal(fixture.focusCalls, 1);
        fixture.event('compositionend');
        fixture.event('input');
        assert.deepEqual(fixture.sent, [['down', 0x010065E5], ['up', 0x010065E5]]);
        fixture.sent.length = 0;
        fixture.event('compositionstart');
        fixture.event('compositionend');
        fixture.text('本');
        assert.deepEqual(fixture.sent, [['down', 0x0100672C], ['up', 0x0100672C]]);
    }
});

test('native backspace, forward delete and control keys preserve their remote meaning', () => {
    const fixture = textInputFixture();
    fixture.show();
    fixture.target.value = '\u200B'.repeat(7);
    fixture.target.selectionStart = 3;
    fixture.event('input');
    fixture.target.value = '\u200B'.repeat(7);
    fixture.target.selectionStart = 4;
    fixture.event('input');
    assert.deepEqual(fixture.sent, [['down', 0xFF08], ['up', 0xFF08], ['down', 0xFFFF], ['up', 0xFFFF]]);
    assert.equal(fixture.scope.$broadcast('guacBeforeKeydown', 0xFF09).defaultPrevented, false);
    assert.equal(fixture.scope.$broadcast('guacBeforeKeyup', 0xFF09).defaultPrevented, false);
});

test('physical Ctrl/Command shortcuts pass through while ordinary text and AltGr use the IME', () => {
    const fixture = textInputFixture();
    fixture.show();
    assert.equal(fixture.scope.$broadcast('guacBeforeKeydown', 97, { modifiers: {} }).defaultPrevented, true);
    assert.equal(fixture.scope.$broadcast('guacBeforeKeyup', 97).defaultPrevented, true);
    for (const modifiers of [{ ctrl: true }, { command: true }, { super: true }]) {
        assert.equal(fixture.scope.$broadcast('guacBeforeKeydown', 120, { modifiers }).defaultPrevented, false);
        assert.equal(fixture.scope.$broadcast('guacBeforeKeyup', 120).defaultPrevented, false);
    }
    assert.equal(fixture.scope.$broadcast('guacBeforeKeydown', 64, { modifiers: { ctrl: true, alt: true } }).defaultPrevented, true);
    fixture.target.blur();
    assert.equal(fixture.scope.$broadcast('guacBeforeKeydown', 97, { modifiers: {} }).defaultPrevented, false);
});

test('destroy removes DOM listeners, drops focus intent and releases forwarded shortcut keys', () => {
    const fixture = textInputFixture();
    fixture.show();
    fixture.scope.$broadcast('guacBeforeKeydown', 97, { modifiers: { command: true } });
    fixture.scope.$broadcast('$destroy');
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.target.onfocus, null);
    assert.equal(fixture.target.onblur, null);
    assert.equal(fixture.service.focused, false);
    assert.deepEqual(fixture.sent, [['up', 97]]);
});

test('destroy releases sticky toolbar modifiers instead of leaving them held remotely', () => {
    for (const native of [true, false]) {
        const fixture = textInputFixture({ native });
        fixture.scope.ctrlPressed = true;
        fixture.scope.altPressed = true;
        fixture.scope.$broadcast('$destroy');
        assert.deepEqual(fixture.sent, [['up', 0xFFE3], ['up', 0xFFE9]]);
    }
});

test('legacy text mode retains initial focus and its existing transient input history', () => {
    const fixture = textInputFixture({ native: false });
    assert.equal(fixture.focusCalls, 1);
    fixture.text('a');
    assert.deepEqual(Array.from(fixture.scope.sentText), ['a']);
    assert.equal(fixture.timeouts.length, 1);
    fixture.timeouts[0]();
    assert.equal(fixture.scope.sentText.length, 0);
    assert.equal(fixture.service.focused, false);
});

test('native input method survives the real preference provider browser-local save and reload', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname,
        '../src/app/settings/services/preferenceService.js'), 'utf8');
    let stored;
    function load() {
        const provider = {};
        vm.runInNewContext(source, {
            navigator: { language: 'en' },
            jstz: { determine: () => ({ name: () => 'Europe/Oslo' }) },
            angular: {
                extend: Object.assign,
                module: () => ({ provider(name, definition) {
                    definition.at(-1).call(provider, { get: () => ({ getItem: () => stored }) });
                } })
            }
        });
        const services = {
            $rootScope: { $on() {} }, $window: { addEventListener() {} },
            localStorageService: { setItem(key, value) {
                assert.equal(key, 'GUAC_PREFERENCES');
                stored = JSON.parse(JSON.stringify(value));
            } }
        };
        return provider.$get.at(-1)({ get: name => services[name] });
    }
    const service = load();
    assert.equal(service.preferences.inputMethod, 'none');
    assert.equal(service.inputMethods.NATIVE, 'native');
    service.preferences.inputMethod = service.inputMethods.NATIVE;
    service.save();
    assert.equal(load().preferences.inputMethod, 'native');
});

test('Show enables Pan desktop before focusing, its toggle keeps focus and disable resets it', () => {
    const fixture = textInputFixture();
    assert.equal(fixture.service.panning, false);
    fixture.show();
    assert.equal(fixture.service.panning, true);
    assert.deepEqual(fixture.focusPanning, [true]);
    fixture.gesture('toggleDesktopPan');
    assert.equal(fixture.service.panning, false);
    assert.equal(fixture.service.focused, true);
    assert.equal(fixture.focusCalls, 1);
    fixture.gesture('toggleDesktopPan');
    assert.equal(fixture.service.panning, true);
    fixture.service.setEnabled(false);
    assert.equal(fixture.service.panning, false);
    fixture.service.setPanning(true);
    assert.equal(fixture.service.panning, false);
});

test('native overlay reports actual observed height and cleans up measurements on destruction', () => {
    const fixture = textInputFixture();
    fixture.watches.get('nativeKeyboard')(true);
    assert.equal(fixture.frames.size, 1);
    fixture.flushFrames();
    assert.equal(fixture.service.toolbarHeight, 44);
    fixture.resizeToolbar(96.25);
    assert.equal(fixture.service.toolbarHeight, 97);
    fixture.windowListeners.get('resize')();
    assert.equal(fixture.frames.size, 1);
    fixture.service.setPanning(true);
    const staleObserver = [...fixture.observers][0];
    fixture.scope.$broadcast('$destroy');
    assert.equal(fixture.service.toolbarHeight, 0);
    assert.equal(fixture.service.panning, false);
    assert.equal(fixture.frames.size, 0);
    assert.equal(fixture.observers.size, 0);
    assert.equal(fixture.windowListeners.size, 0);
    staleObserver.callback();
    assert.equal(fixture.service.toolbarHeight, 0);
});

test('legacy input never reserves native overlay clearance and invalid heights are ignored', () => {
    const fixture = textInputFixture({ native: false });
    fixture.resizeToolbar(100);
    assert.equal(fixture.service.toolbarHeight, 0);
    fixture.service.setEnabled(true);
    for (const height of [NaN, Infinity, -5, '40']) {
        fixture.service.setToolbarHeight(height);
        assert.equal(fixture.service.toolbarHeight, 0);
    }
    fixture.service.setToolbarHeight(44.5);
    assert.equal(fixture.service.toolbarHeight, 45);
    fixture.service.setEnabled(false);
    assert.equal(fixture.service.toolbarHeight, 0);
});


test('native overlay measurement falls back to resize events without idle polling', () => {
    const fixture = textInputFixture({ resizeObserver: false });
    fixture.watches.get('nativeKeyboard')(true);
    fixture.flushFrames();
    assert.equal(fixture.service.toolbarHeight, 44);
    assert.equal(fixture.frames.size, 0);
    fixture.toolbar.height = 96;
    fixture.windowListeners.get('resize')();
    fixture.windowListeners.get('resize')();
    assert.equal(fixture.frames.size, 1);
    fixture.flushFrames();
    assert.equal(fixture.service.toolbarHeight, 96);
    assert.equal(fixture.frames.size, 0);
    assert.equal(fixture.timeouts.length, 0);
    fixture.scope.$broadcast('$destroy');
    assert.equal(fixture.windowListeners.size, 0);
});


test('only explicit Show rearms Pan; plain editor focus and in-progress composition preserve opt-out', () => {
    const fixture = textInputFixture();
    fixture.show();
    fixture.gesture('toggleDesktopPan');
    assert.equal(fixture.service.panning, false);
    fixture.target.blur();
    fixture.target.focus();
    fixture.text('a');
    assert.equal(fixture.service.panning, false);
    assert.equal(fixture.focusCalls, 2);
    fixture.event('compositionstart');
    fixture.text('日');
    fixture.show();
    assert.equal(fixture.service.panning, false);
    assert.equal(fixture.focusCalls, 2);
    fixture.event('compositionend');
    fixture.show();
    assert.equal(fixture.service.panning, true);
    assert.equal(fixture.focusCalls, 3);
    assert.deepEqual(fixture.focusPanning, [true, false, true]);
    assert.deepEqual(fixture.focusGestures, [true, false, true]);
});


test('explicit Hide disables Pan without reopening while ordinary blur preserves its setting', () => {
    const fixture = textInputFixture();
    fixture.show();
    assert.equal(fixture.service.panning, true);
    fixture.target.blur();
    assert.equal(fixture.service.panning, true);
    fixture.target.focus();
    fixture.hide();
    assert.equal(fixture.service.panning, false);
    assert.equal(fixture.service.focused, false);
    assert.equal(fixture.focusCalls, 2);
    fixture.watches.get('nativeKeyboard')(true);
    fixture.flushFrames();
    assert.equal(fixture.focusCalls, 2);
    fixture.show();
    assert.equal(fixture.service.panning, true);
    assert.equal(fixture.focusCalls, 3);
});
