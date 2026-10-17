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

// Runs the common-js Jasmine suite in an isolated local Chrome profile. Unlike
// Firefox-only CI this also exercises real WebCodecs H.264 decoding when present.
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackBrowserProcess } from '../../../scripts/benchmarks/browser-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(executable);
const moduleDirectory = path.join(root, 'src/main/webapp/modules');
const specDirectory = path.join(root, 'src/test/javascript');
const script = source => '<script>' + source.replaceAll('</script', '<\\/script') + '</script>';
const sources = async directory => (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.js')).sort()
    .map(name => readFile(path.join(directory, name), 'utf8')))).map(script).join('');
const token = randomBytes(24).toString('hex');
const reportPath = '/results/' + token;
const html = '<!doctype html><meta charset="utf-8"><body>'
    + script(await readFile(path.join(root, 'node_modules/jasmine-core/lib/jasmine-core/jasmine.js'), 'utf8'))
    + script(`window.jasmine=jasmineRequire.core(jasmineRequire);var env=jasmine.getEnv();Object.assign(window,jasmineRequire.interface(jasmine,env));
        var results={browser:navigator.userAgent,secure:window.isSecureContext,count:0,failed:[],pending:[]};
        env.addReporter({specDone:function(r){results.count++;if(r.status==='failed')results.failed.push({name:r.fullName,errors:r.failedExpectations});
        if(r.status==='pending')results.pending.push({name:r.fullName,reason:r.pendingReason});
        if(r.fullName.indexOf('real WebCodecs')>=0)results.realWebCodecs=r.status;},
        jasmineDone:function(r){results.status=r.overallStatus;results.global=r.failedExpectations;
        fetch(${JSON.stringify(reportPath)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(results)});}});`)
    + await sources(moduleDirectory) + await sources(specDirectory) + script('jasmine.getEnv().execute();');
let receive;
const result = new Promise(resolve => { receive = resolve; });
const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end(html);
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
let temporary, browser, stop, deadline;
try {
    temporary = await mkdtemp(path.join(tmpdir(), 'guacamole-browser-tests-'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(executable, ['--headless', '--disable-background-networking', '--disable-component-update',
        '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + temporary,
        'http://127.0.0.1:' + server.address().port + '/'], { stdio: ['ignore', 'ignore', 'pipe'] });
    stop = trackBrowserProcess(browser);
    browser.stderr.resume();
    const failure = new Promise((resolve, reject) => {
        browser.once('error', reject);
        browser.once('exit', code => reject(new Error('Browser exited before reporting: ' + code)));
        deadline = setTimeout(() => reject(new Error('Browser tests timed out')), 60000);
    });
    const report = await Promise.race([result, failure]);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed' || report.pending.length) process.exitCode = 1;
}
finally {
    clearTimeout(deadline);
    if (stop) await stop();
    await new Promise(resolve => server.close(resolve));
    if (temporary) await rm(temporary, { recursive: true, force: true });
}
