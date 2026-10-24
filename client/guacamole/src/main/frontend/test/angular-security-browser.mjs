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
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = process.argv.slice(2);
const simulateIE = options.includes('--simulate-ie');
const source = options.find(value => !value.startsWith('--')) || path.join(here, '../node_modules/angular/angular.js');
const firefox = !process.env.CHROME_BIN && (process.env.FIREFOX_BIN || process.platform === 'linux');
const executable = firefox ? (process.env.FIREFOX_BIN || '/usr/bin/firefox')
    : (process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
await access(executable);
const reportPath = '/results/' + randomBytes(24).toString('hex');
const scripts = new Map([
    ['/angular.js', await readFile(source)],
    ['/tests.js', await readFile(path.join(here, 'angular-security-browser.js'))]
]);
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>'
    + (simulateIE ? '<script>Object.defineProperty(document,"documentMode",{value:11});</script>' : '')
    + '<script src="/angular.js"></script><script src="/tests.js"></script><script>'
    + 'fetch(' + JSON.stringify(reportPath) + ',{method:"POST",body:JSON.stringify('
    + 'window.greenmoleSecurityResults||{status:"failed",error:"Suite did not finish"})});'
    + '</script></body></html>';
let receive;
const result = new Promise(resolve => { receive = resolve; });
const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; style-src 'unsafe-inline'" });
        response.end(html);
    }
    else if (request.method === 'GET' && scripts.has(request.url)) {
        response.writeHead(200, { 'Content-Type': 'application/javascript' });
        response.end(scripts.get(request.url));
    }
    else if (request.method === 'POST' && request.url === reportPath) {
        let body = '', size = 0;
        request.on('data', data => {
            size += data.length;
            if (size > 1024 * 1024) request.destroy();
            else body += data;
        });
        request.on('end', () => {
            try { receive(JSON.parse(body)); response.writeHead(204).end(); }
            catch { response.writeHead(400).end(); }
        });
    }
    else response.writeHead(404).end();
});
let temporary, stop, deadline;
try {
    temporary = await mkdtemp(path.join(tmpdir(), 'greenmole-security-tests-'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const arguments_ = firefox ? ['--headless', '--no-remote', '--profile', temporary, url]
        : ['--headless', '--disable-background-networking',
        '--disable-component-update', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + temporary, url];
    const browser = spawn(executable, arguments_,
        { stdio: ['ignore', 'ignore', 'pipe'] });
    // Keep the runner within the client build context. Cleanup is bounded even
    // when startup fails or a browser hangs while exercising a regression.
    let closed = !browser.pid;
    const completion = new Promise(resolve => {
        browser.once('close', () => { closed = true; resolve(); });
        browser.once('error', () => { if (!browser.pid) { closed = true; resolve(); } });
    });
    stop = async () => {
        for (const signal of ['SIGTERM', 'SIGKILL']) {
            if (closed) return true;
            browser.kill(signal);
            let timer;
            await Promise.race([completion, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
            clearTimeout(timer);
        }
        return closed;
    };
    browser.stderr.resume();
    const failure = new Promise((resolve, reject) => {
        browser.once('error', reject);
        browser.once('exit', code => reject(new Error('Browser exited before reporting: ' + code)));
        deadline = setTimeout(() => reject(new Error('Security regressions timed out')), 45000);
    });
    const report = await Promise.race([result, failure]);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
}
finally {
    clearTimeout(deadline);
    if (stop && !await stop()) process.exitCode = 1;
    await new Promise(resolve => server.close(resolve));
    if (temporary) await rm(temporary, { recursive: true, force: true });
}
