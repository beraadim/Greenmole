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
const test = require('node:test');
const MessageFormat = require('messageformat');
const configure = require('../src/app/locale/legacyMessageFormat');

test('legacy literal escapes compose without creating ICU quoting or interpolation', () => {
    const format = configure(new MessageFormat('en'));
    const atoms = [
        ['a', 'a'], ["'", "'"], ["''", "''"],
        ['\\{', '{'], ['\\}', '}'], ['\\#', '#'], ['\\\\', '\\'],
        ['\\u0027', "'"], ['\\u007b', '{'], ['\\u007d', '}'],
        ['\\u0023', '#'], ['\\uD83D\\uDE00', '😀']
    ];
    const contexts = [
        value => value,
        value => '{n, plural, one{' + value + '} other{' + value + '}}',
        value => '{n, plural, other{{mode, select, yes{' + value + '} other{' + value + '}}}}'
    ];
    // Adjacent quote/escape runs exposed regressions that individual escapes
    // do not: ICU interprets adjacent closing/opening quotes as a literal '.
    for (const a of atoms) for (const b of atoms) for (const c of [['', ''], ...atoms]) {
        const source = a[0] + b[0] + c[0];
        const expected = a[1] + b[1] + c[1];
        for (const context of contexts)
            assert.equal(format.compile(context(source))({ n: 2, mode: 'yes' }), expected, source);
    }
});

test('legacy quoted variables, plural offsets and nested selects keep their meaning', () => {
    const format = configure(new MessageFormat('en'));
    assert.equal(format.compile("Say '{name}'")({ name: 'æøå' }), "Say 'æøå'");
    assert.equal(format.compile('\\{name\\}')({ name: 'not interpolated' }), '{name}');
    assert.equal(format.compile('{n, plural, offset:1 =0{zero} one{# \\#} other{# items}}')({ n: 2 }), '1 #');
    assert.equal(format.compile('{n, selectordinal, one{#st} two{#nd} few{#rd} other{#th}}')({ n: 2 }), '2nd');
    assert.equal(format.compile('{n, plural, other{{mode, select, yes{# \\#} other{no}}}}')({ n: 2, mode: 'yes' }), '2 #');
    assert.equal(format.compile('{mode, select, yes{A, plural, \\#} other{none}}')({ mode: 'yes' }), 'A, plural, #');
    assert.equal(format.compile('{mode, select, yes{{n, plural, other{# \\#}}} other{none}}')({ mode: 'yes', n: 2 }), '2 #');
    // Interpolation values are never normalized as translation source.
    assert.equal(format.compile('{value}')({ value: "\\{not syntax\\} '#'<tag>" }), "\\{not syntax\\} '#'<tag>");
});

test('invalid legacy backslash escapes are rejected', () => {
    const format = configure(new MessageFormat('en'));
    for (const source of ['\\', '\\n', '\\q', '\\u12gg', '\\u123'])
        assert.throws(() => format.compile(source), SyntaxError);
});

test('translation compilation rejects nested message maps before inspecting their keys', () => {
    const format = configure(new MessageFormat('en'));
    const marker = 'greenmoleMessageFormatPrototypeProbe';
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    const maps = [
        JSON.parse('{"__proto__":{"' + marker + '":"unexpected"}}'),
        JSON.parse('{"constructor":{"prototype":{"' + marker + '":"unexpected"}}}'),
        Object.create({ inheritedMessage: 'unexpected' }),
        ['a message'], null, undefined, 1, new String('a message')
    ];
    const unreadable = {};
    Object.defineProperty(unreadable, 'message', {
        enumerable: true,
        get() { throw new Error('Message map must not be inspected'); }
    });
    maps.push(unreadable);
    for (const source of maps)
        assert.throws(() => format.compile(source), {
            name: 'TypeError', message: 'MessageFormat translation source must be a string'
        });
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
    assert.equal(format.compile('{name}')({ name: marker }), marker);
});
