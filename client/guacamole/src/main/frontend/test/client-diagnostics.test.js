/*
 * Licensed to the Apache Software Foundation (ASF) under one or more contributor
 * license agreements. See the NOTICE file distributed with this work for
 * additional information regarding copyright ownership. The ASF licenses this
 * file to you under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed
 * under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources } = require('./helpers/client-fixtures');

function fixture() {
    const loaded = sources(['client/directives/guacClientDiagnostics.js']);
    const directive = loaded.directives.guacClientDiagnostics;
    const intervals = new Set();
    let changed, destroy;
    const scope = {
        $watchGroup(properties, callback) { changed = callback; },
        $on(event, callback) { assert.equal(event, '$destroy'); destroy = callback; }
    };
    const interval = function(callback, duration) {
        assert.equal(duration, 1000);
        const entry = { callback };
        intervals.add(entry);
        return entry;
    };
    interval.cancel = entry => intervals.delete(entry);
    directive.controller.at(-1)(scope, interval);
    return { scope, intervals, changed: () => changed(), destroy: () => destroy(),
        tick: () => [...intervals].forEach(entry => entry.callback()) };
}

function monitor(name) {
    const calls = [];
    let sample = 0;
    return {
        calls,
        start() { calls.push('start'); },
        stop() { calls.push('stop'); },
        sample() {
            calls.push('sample');
            return { monitor: name, count: ++sample, videoTiming: {
                assemblyAverageMs: 1, assemblyMaxMs: 2,
                encodedQueueAverageMs: 3, encodedQueueMaxMs: 4,
                decodeOutputAverageMs: 5, decodeOutputMaxMs: 6,
                orderedDisplayAverageMs: 7, orderedDisplayMaxMs: 8
            } };
        }
    };
}

test('hidden performance overlay collects nothing; explicit enable samples on the existing interval', () => {
    const f = fixture(), performance = monitor('one');
    f.scope.client = { clientProperties: { showStatistics: false }, performance };
    f.changed();
    assert.deepEqual(performance.calls, []);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.scope.sample, null);
    f.scope.client.clientProperties.showStatistics = true;
    f.changed();
    assert.deepEqual(performance.calls, ['start', 'sample']);
    assert.equal(f.intervals.size, 1);
    assert.equal(f.scope.sample.videoTiming.decodeOutputAverageMs, 5);
    f.tick();
    assert.equal(f.scope.sample.count, 2);
    f.scope.client.clientProperties.showStatistics = false;
    f.changed(); f.tick();
    assert.deepEqual(performance.calls, ['start', 'sample', 'sample', 'stop']);
    assert.equal(f.scope.sample, null);
    assert.equal(f.intervals.size, 0);
});

test('switching the focused client stops the old collector and destruction removes the last interval', () => {
    const f = fixture(), first = monitor('one'), second = monitor('two');
    f.scope.client = { clientProperties: { showStatistics: true }, performance: first };
    f.changed();
    f.scope.client = { clientProperties: { showStatistics: true }, performance: second };
    f.changed(); f.tick();
    assert.deepEqual(first.calls, ['start', 'sample', 'stop']);
    assert.deepEqual(second.calls, ['start', 'sample', 'sample']);
    assert.equal(f.scope.sample.monitor, 'two');
    assert.equal(f.intervals.size, 1);
    f.destroy(); f.tick();
    assert.deepEqual(second.calls, ['start', 'sample', 'sample', 'stop']);
    assert.equal(f.scope.sample, null);
    assert.equal(f.intervals.size, 0);
});

test('old clients without a performance monitor create no diagnostic work', () => {
    const f = fixture();
    f.scope.client = { clientProperties: { showStatistics: true } };
    f.changed(); f.tick();
    assert.equal(f.scope.sample, null);
    assert.equal(f.intervals.size, 0);
    f.destroy();
});
