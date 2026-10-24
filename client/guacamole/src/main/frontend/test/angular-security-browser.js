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

/* Behavioral regressions for the advisory IDs in vendor/angularjs/SECURITY-PATCHES.md.
 * Runs only in an isolated browser on loopback, with external resources blocked.
 * These tests exercise Angular's public APIs, not patch text or package names.
 */
(function() {
    'use strict';

    var results = { version: angular.version.full, tests: [], failures: [] };
    function assert(value, message) {
        if (!value) throw new Error(message);
    }
    function equal(actual, expected) {
        assert(actual === expected, JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
    }
    function test(name, body) {
        var start = performance.now();
        try {
            body();
            results.tests.push({ name: name, status: 'passed', milliseconds: performance.now() - start });
        }
        catch (error) {
            results.failures.push({ name: name, message: error.message });
            results.tests.push({ name: name, status: 'failed', milliseconds: performance.now() - start });
        }
    }

    angular.module('securityRegression', [])
        .config(['$compileProvider', '$sceDelegateProvider', function(compile, sce) {
            compile.imgSrcSanitizationTrustedUrlList(/^https:\/\/allowed\.invalid\//);
            sce.trustedResourceUrlList([
                /https:\/\/first\.invalid\/.*|https:\/\/second\.invalid\/.*/
            ]);
        }]);
    var injector = angular.injector(['ng', 'securityRegression']);
    var compile = injector.get('$compile');
    var scope = injector.get('$rootScope');
    function element(markup, value) {
        var child = scope.$new();
        child.value = value;
        var node = compile(markup)(child);
        child.$digest();
        child.$destroy();
        return node[0];
    }
    function blocked(value) {
        assert(value && value.indexOf('unsafe:') >= 0, 'Disallowed URL was not sanitized: ' + value);
    }

    test('CVE-2026-11998: SCE alternatives must match the whole resource URL', function() {
        var sce = injector.get('$sce');
        equal(sce.getTrustedResourceUrl('https://first.invalid/a.js'), 'https://first.invalid/a.js');
        equal(sce.getTrustedResourceUrl('https://second.invalid/b.js'), 'https://second.invalid/b.js');
        ['https://denied.invalid/a#https://second.invalid/',
            'data:text/javascript,void(0)//https://second.invalid/'].forEach(function(url) {
            var rejected = false;
            try { sce.getTrustedResourceUrl(url); }
            catch (error) { rejected = error.message.indexOf('insecurl') >= 0; }
            assert(rejected, 'Resource URL bypassed the allowlist');
        });
    });

    test('CVE-2023-26116: RegExp copy preserves flags without evaluating toString', function() {
        var original = /test/gi;
        original.lastIndex = 3;
        original.toString = function() { throw new Error('Untrusted toString executed'); };
        var copy = angular.copy(original);
        equal(copy.source, original.source);
        equal(copy.flags, 'gi');
        equal(copy.lastIndex, 3);
    });

    test('CVE-2022-25844: currency locale whitespace remains bounded', function() {
        var format = injector.get('$locale').NUMBER_FORMATS.PATTERNS[1];
        var saved = angular.copy(format);
        try {
            var start = performance.now();
            format.posPre = ' '.repeat(40000) + '\u00a4';
            equal(injector.get('$filter')('currency')(42, '', 2), '42.00');
            format.posPre = ' '.repeat(40000);
            // No symbol is legal: all existing whitespace is preserved.
            equal(injector.get('$filter')('currency')(42, '', 2).trim(), '42.00');
            format.posPre = ' '.repeat(40000) + 'x\u00a4';
            equal(injector.get('$filter')('currency')(42, '', 2), ' '.repeat(40000) + 'x42.00');
            assert(performance.now() - start < 1000, 'Currency formatting monopolized the browser');
        }
        finally { angular.copy(saved, format); }
    });

    test('CVE-2023-26118: URL validation accepts real URLs and rejects malformed input promptly', function() {
        var child = scope.$new();
        var input = compile('<input type="url" ng-model="value">')(child);
        var controller = input.controller('ngModel');
        var validate = controller.$validators.url;
        ['https://example.invalid/a?b=c#d', 'ftp://example.invalid/file',
            'https://[::1]:8443/path'].forEach(function(url) { assert(validate(url, url), 'Valid URL rejected'); });
        ['not a URL', 'http://', 'http://[invalid]', 'https://a b/'].forEach(function(url) {
            assert(!validate(url, url), 'Invalid URL accepted');
        });
        var start = performance.now();
        var hostile = 'http://' + 'a'.repeat(40000) + ':' + '/'.repeat(1000) + '\n';
        validate(hostile, hostile);
        assert(performance.now() - start < 1000, 'URL validation monopolized the browser');
        child.$destroy();
    });

    ['ng-srcset="{{value}}"', 'ng-attr-srcset="{{value}}"', 'srcset="{{value}}"',
        'ng-prop-srcset="value"'].forEach(function(binding) {
        test('CVE-2024-8372: every img candidate is checked via ' + binding, function() {
            var node = element('<img ' + binding + '>',
                'https://allowed.invalid/a xyz,https://denied.invalid/b');
            blocked(node.getAttribute('srcset'));
        });
        test('CVE-2024-8373: source candidates are checked via ' + binding, function() {
            var node = element('<picture><source ' + binding + '></picture>', 'https://denied.invalid/b');
            blocked(node.firstElementChild.getAttribute('srcset'));
        });
        test('Nested descriptor parentheses cannot hide img/source candidates via ' + binding, function() {
            // HTML's descriptor parser uses an in-parentheses state, not a
            // nesting counter. A sanitizer must agree about the next comma.
            var value = 'https://allowed.invalid/a 1x((x),https://denied.invalid/b 2x';
            blocked(element('<img ' + binding + '>', value).getAttribute('srcset'));
            blocked(element('<picture><source ' + binding + '></picture>', value)
                .firstElementChild.getAttribute('srcset'));
        });
    });

    test('CVE-2024-21490: long srcset whitespace does not stall parsing', function() {
        var start = performance.now();
        var node = element('<img ng-srcset="{{value}}">',
            'https://allowed.invalid/a' + ' '.repeat(40000) + '1x, https://allowed.invalid/b 2x');
        assert(performance.now() - start < 1000, 'Srcset parsing monopolized the browser');
        assert(node.srcset.indexOf('https://allowed.invalid/b') >= 0, 'Second candidate lost');
    });

    ['ng-attr-href="{{value}}"', 'href="{{value}}"', 'ng-attr-xlink:href="{{value}}"',
        'xlink:href="{{value}}"'].forEach(function(binding) {
        test('CVE-2025-0716: SVG image URL is checked via ' + binding, function() {
            var node = element('<svg><image ' + binding + '></image></svg>', 'https://denied.invalid/b');
            var image = node.firstElementChild;
            blocked(image.getAttribute('href') || image.getAttribute('xlink:href'));
        });
    });

    test('Safe srcset descriptors and data URL commas retain their meaning', function() {
        var normalInjector = angular.injector(['ng']);
        var child = normalInjector.get('$rootScope').$new();
        child.value = 'data:image/png;base64,iVBORw0KGgo= 1x, https://allowed.invalid/a 2x';
        var node = normalInjector.get('$compile')('<img ng-srcset="{{value}}">')(child)[0];
        child.$digest();
        equal(node.srcset.replace(/,\s+/g, ','), child.value.replace(/,\s+/g, ','));
        child.$destroy();
    });

    test('Normal textarea interpolation and model text remain literal', function() {
        equal(element('<textarea>{{value}}</textarea>', 'Norwegian: æ ø å').value,
            document.documentMode ? '{{value}}' : 'Norwegian: æ ø å');
        equal(element('<textarea ng-model="value"></textarea>', '{{1+2}} <tag> æøå').value,
            '{{1+2}} <tag> æøå');
    });

    if (document.documentMode) {
        test('CVE-2022-25869: simulated IE restored textarea text is never evaluated', function() {
            var child = scope.$new();
            var evaluations = 0;
            child.probe = function() { evaluations++; return 'evaluated'; };
            var textarea = document.createElement('textarea');
            textarea.textContent = '{{probe()}}';
            compile(textarea)(child);
            child.$digest();
            equal(evaluations, 0);
            equal(textarea.value, '{{probe()}}');
            child.$destroy();
        });
    }

    test('Unshipped optional Angular resource and sanitize services stay absent', function() {
        assert(!injector.has('$resource'), 'Unexpected angular-resource runtime payload');
        assert(!injector.has('$sanitize'), 'Unexpected angular-sanitize runtime payload');
    });

    results.status = results.failures.length ? 'failed' : 'passed';
    results.simulatedIEDocumentMode = document.documentMode || null;
    window.greenmoleSecurityResults = results;
})();
