/*
 * Copyright 2026 Greenmole contributors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const webpack = require('webpack');
const TemplateCachePlugin = require('../plugins/angular-template-cache-plugin');

const frontend = path.resolve(__dirname, '..');

test('installed AngularJS is the reviewed source, with no original nested runtime', () => {
    const vendor = path.join(frontend, 'vendor/angularjs');
    const provenance = JSON.parse(fs.readFileSync(path.join(vendor, 'provenance.json')));
    const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    assert.equal(sha(path.join(vendor, 'angular.js')), provenance.patchedAngularSha256);
    assert.equal(sha(path.join(vendor, 'angular-1.8.3-security.patch')), provenance.patchSha256);
    const installed = fs.realpathSync(require.resolve('angular/angular.js'));
    assert.equal(installed, path.join(vendor, 'angular.js'));
    const lock = JSON.parse(fs.readFileSync(path.join(frontend, 'package-lock.json')));
    for (const name of Object.keys(lock.packages)) {
        if (name.endsWith('node_modules/angular'))
            assert.equal(lock.packages[name].resolved, 'vendor/angularjs');
        assert(!name.endsWith('node_modules/angular-resource'));
        assert(!name.endsWith('node_modules/angular-sanitize'));
    }
});

test('template cache keeps nested URLs, whitespace behavior and literal content', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmole-template-test-'));
    try {
        fs.mkdirSync(path.join(temporary, 'app/nested'), { recursive: true });
        fs.writeFileSync(path.join(temporary, 'entry.js'), '');
        fs.writeFileSync(path.join(temporary, 'app/nested/template.html'),
            '<div>  Norwegian: æ ø å  </div>\n<textarea> literal \' \\ \u2028 </textarea>');
        fs.writeFileSync(path.join(temporary, 'app/ignore.txt'), 'ignore');
        await new Promise((resolve, reject) => {
            const compiler = webpack({
                context: temporary, mode: 'none', entry: './entry.js',
                output: { path: path.join(temporary, 'dist') },
                plugins: [new TemplateCachePlugin({
                    module: 'templates-main', root: 'app/',
                    sourceDirectory: 'app', outputFilename: 'templates.js'
                })]
            });
            compiler.run((error, stats) => compiler.close(closeError => {
                if (error || closeError) reject(error || closeError);
                else if (stats.hasErrors()) reject(new Error(stats.toString()));
                else resolve();
            }));
        });
        const templates = {};
        const sandbox = { angular: { module(name, dependencies) {
            assert.equal(name, 'templates-main');
            assert.equal(dependencies.length, 0);
            return { run(injection) {
                injection[1]({ put: (key, value) => { templates[key] = value; } });
            } };
        } } };
        vm.runInNewContext(fs.readFileSync(path.join(temporary, 'dist/templates.js'), 'utf8'), sandbox);
        assert.deepEqual(Object.keys(templates), ['app/nested/template.html']);
        assert.equal(templates['app/nested/template.html'],
            '<div>Norwegian: æ ø å</div><textarea> literal \' \\ \u2028 </textarea>');
    }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('MessageFormat compiles every shipped locale and preserves ICU plural/select behavior', () => {
    const MessageFormat = require('messageformat');
    const configure = require('../src/app/locale/legacyMessageFormat');
    const directory = path.join(frontend, 'src/translations');
    let locales = 0;
    const strings = object => Object.values(object).flatMap(value =>
        typeof value === 'string' ? [value] : value && typeof value === 'object' ? strings(value) : []);
    for (const filename of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
        const locale = filename.slice(0, -5).replace('_', '-');
        const format = configure(new MessageFormat(locale));
        const translations = JSON.parse(fs.readFileSync(path.join(directory, filename)));
        for (const value of strings(translations)) assert.equal(typeof format.compile(value.replace(/\$\{project.version\}/g, '1.6.1')), 'function');
        const plural = format.compile('{count, plural, =0{zero} =1{one} other{# items}}');
        assert.equal(plural({ count: 0 }), 'zero');
        assert.equal(plural({ count: 1 }), 'one');
        assert(plural({ count: 42 }).endsWith(' items'));
        const select = format.compile('{mode, select, input{{name}} other{unknown}}');
        assert.equal(select({ mode: 'input', name: 'æøå' }), 'æøå');
        assert.equal(select({ mode: 'missing' }), 'unknown');
        locales++;
    }
    assert(locales >= 16);
    assert.equal({}.polluted, undefined);
});

test('CSV browser parser retains array rows, quoting and literal prototype-like headings', async () => {
    const { parse } = await import('csv-parse/browser/esm/sync');
    const result = parse('name,__proto__,constructor\r\n"Mac, mini","line 1\nline 2",æøå\r\n\r\n',
        { skip_empty_lines: true });
    assert.deepEqual(result, [['name', '__proto__', 'constructor'], ['Mac, mini', 'line 1\nline 2', 'æøå']]);
    assert.equal({}.polluted, undefined);
});
