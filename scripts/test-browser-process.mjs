#!/usr/bin/env node
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
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackBrowserProcess } from './benchmarks/browser-process.mjs';

test('cleanup accepts an already completed process without a future exit event', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'close');
    assert.equal(await trackBrowserProcess(child)(), true);
});

test('cleanup accepts an already signaled process with a null exit code', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    await once(child, 'spawn'); child.kill('SIGTERM'); await once(child, 'close');
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(await trackBrowserProcess(child)(), true);
});

test('failed executable startup does not require an exit event', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'guacamole-spawn-test-'));
    try {
        const executable = path.join(directory, 'not-executable');
        await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
        const child = spawn(executable);
        const stop = trackBrowserProcess(child, { graceMs: 20, killMs: 20 });
        const [error] = await once(child, 'error');
        assert.equal(error.code, 'EACCES'); assert.equal(await stop(), true);
    }
    finally { await rm(directory, { recursive: true, force: true }); }
});

test('a running process is stopped with the existing graceful signal', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const stop = trackBrowserProcess(child);
    await once(child, 'spawn'); assert.equal(await stop(), true);
    assert.equal(child.signalCode, 'SIGTERM');
});

test('a process ignoring the graceful signal is killed within a bounded wait', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"]);
    const stop = trackBrowserProcess(child, { graceMs: 20, killMs: 1000 });
    try {
        await once(child.stdout, 'data'); assert.equal(await stop(), true);
        assert.equal(child.signalCode, 'SIGKILL');
    }
    finally { child.kill('SIGKILL'); }
});

test('missing completion after failed signals returns instead of waiting indefinitely', async () => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null, pid: 1234 });
    const signals = []; child.kill = signal => { signals.push(signal); return false; };
    const stop = trackBrowserProcess(child, { graceMs: 10, killMs: 10 });
    assert.equal(await stop(), false); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
