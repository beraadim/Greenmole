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

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources } = require('./helpers/client-fixtures');

function fixture(enabled, capability, mode, avc444 = () => Promise.resolve(true)) {
    let calls = 0, saves = 0;
    const preferences = { experimentalAvc420: enabled, experimentalVideoMode: mode };
    const loaded = sources(['client/services/guacVideo.js'], {
        window: { isSecureContext: true },
        Guacamole: {
            AVC420VideoPlayer: { MIMETYPE: 'video/x-guacamole-avc420;v=1', checkSupport() { calls++; return capability(); } },
            AVC444VideoPlayer: { MIMETYPE: 'video/x-guacamole-avc444;v=1', checkSupport() { return avc444(); } }
        }
    });
    const service = loaded.factories.guacVideo({ get(name) {
        if (name === '$q') return { when: value => Promise.resolve(value), all: values => Promise.all(values) };
        if (name === 'preferenceService') return { preferences, save() { saves++; } };
        throw new Error('Unexpected dependency ' + name);
    } });
    return { service, preferences, calls: () => calls, saves: () => saves };
}

test('private video defaults off and never delays image connection setup on a pending probe', async () => {
    const f = fixture(false, () => new Promise(() => {}));
    assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), []);
    assert.equal(f.calls(), 1);
});
test('legacy explicit opt-in remains AVC420 and waits for capability confirmation', async () => {
    let resolve;
    const f = fixture(true, () => new Promise(done => { resolve = done; }));
    let completed = false;
    const types = f.service.getSupportedMimetypes().then(value => { completed = true; return value; });
    await Promise.resolve(); assert.equal(completed, false);
    resolve(true);
    assert.equal(f.service.mode, 'avc420');
    assert.deepEqual(Array.from(await types), ['video/x-guacamole-avc420;v=1']);
    assert.equal(f.service.available, true);
});
test('unsupported and failed capability checks retain the image-only connection', async () => {
    for (const capability of [() => Promise.resolve(false), () => Promise.reject(new Error('unsupported'))]) {
        const f = fixture(true, capability);
        assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), []);
        assert.equal(f.service.available, false); assert.equal(f.service.checked, true);
    }
});
test('non-boolean legacy opt-ins do not enable video, explicit selection persists', async () => {
    const f = fixture('true', () => Promise.resolve(true));
    assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), []);
    f.service.mode = 'avc420'; f.service.save();
    assert.equal(f.saves(), 1); assert.equal(f.preferences.experimentalVideoMode, 'avc420');
    assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), ['video/x-guacamole-avc420;v=1']);
});
test('AVC444 explicitly advertises its distinct capability first and permits AVC420 hosts', async () => {
    const f = fixture(false, () => Promise.resolve(true), 'avc444');
    assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), ['video/x-guacamole-avc444;v=1', 'video/x-guacamole-avc420;v=1']);
    f.service.save(); assert.equal(f.preferences.experimentalAvc420, false);
});
test('failed native-plane/GPU capability never advertises AVC444 but keeps AVC420 available', async () => {
    const f = fixture(false, () => Promise.resolve(true), 'avc444', () => Promise.resolve(false));
    assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), ['video/x-guacamole-avc420;v=1']);
    assert.equal(f.service.avc444Available, false); assert.equal(f.service.available, false);
});
test('an explicit image choice overrides an old opt-in; invalid selections never enable video', async () => {
    const f = fixture(true, () => Promise.resolve(true), 'images');
    assert.deepEqual(Array.from(await f.service.getSupportedMimetypes()), []);
    f.service.mode = 'unknown'; f.service.save(); assert.equal(f.preferences.experimentalVideoMode, 'images');
});
