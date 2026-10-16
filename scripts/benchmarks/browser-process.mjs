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

/** Track immediately after spawn, before any asynchronous startup work.
 * Both signals and failed spawns may leave exitCode null. Never wait for a new
 * exit event during cleanup: it may already have fired or may never occur. */
export function trackBrowserProcess(child, { graceMs = 3000, killMs = 3000 } = {}) {
    let finished = child.exitCode !== null || child.signalCode !== null || !child.pid;
    let resolveFinished;
    const completion = new Promise(resolve => { resolveFinished = resolve; });
    const finish = () => { finished = true; resolveFinished(); };
    // Keep an error listener even for a failed spawn whose error event is still
    // queued. The startup caller separately handles and reports that failure.
    child.once('close', finish);
    child.once('error', () => { if (!child.pid) finish(); });
    if (finished) resolveFinished();

    async function wait(milliseconds) {
        let timer;
        try {
            await Promise.race([completion, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]);
            return finished || child.exitCode !== null || child.signalCode !== null;
        }
        finally { clearTimeout(timer); }
    }

    return async function stopBrowser() {
        if (finished) return true;
        child.kill('SIGTERM');
        if (await wait(graceMs)) return true;
        child.kill('SIGKILL');
        // A failed kill or missing close event must not turn a failed benchmark
        // into an unbounded wait. The caller can report incomplete cleanup.
        return wait(killMs);
    };
}
