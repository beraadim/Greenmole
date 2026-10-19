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

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sources } = require('./helpers/client-fixtures');
const bounds = sources(['client/types/ClientViewBounds.js']).factories.ClientViewBounds();

function fixture({ width = 1200, height = 900, scale = 1, left = 0, top = 0,
        viewLeft = 0, viewTop = 0, viewWidth = 600, viewHeight = 400,
        borderLeft = 0, borderTop = 0 } = {}) {
    const scroll = { left: 99, top: 121 };
    const main = {
        clientWidth: viewWidth, clientHeight: viewHeight,
        clientLeft: borderLeft, clientTop: borderTop,
        scrollLeft: scroll.left, scrollTop: scroll.top,
        getBoundingClientRect: () => ({ left: viewLeft, top: viewTop,
            width: viewWidth + borderLeft + 3, height: viewHeight + borderTop + 3 })
    };
    const container = {
        getBoundingClientRect: () => ({ left, top, width: width * scale, height: height * scale }),
        // Deliberately unrelated to document coordinates: nested offsetParents
        // are why the production helper uses bounding rectangles.
        offsetLeft: 733, offsetTop: 877
    };
    const display = { getWidth: () => width, getHeight: () => height, getScale: () => scale };
    const get = visual => bounds.get(main, container, display, visual);
    return { main, container, display, get, scroll };
}

function result(value) {
    return value && { ...value };
}

test('visible bounds select the clipped desktop without effects or duplicate scroll offsets', () => {
    const f = fixture({ left: -250, top: -175 });
    assert.deepEqual(result(f.get()), { minX: 250, minY: 175, maxX: 849, maxY: 574, clipped: true });
    assert.equal(f.main.scrollLeft, f.scroll.left);
    assert.equal(f.main.scrollTop, f.scroll.top);
});

test('centered fitted desktop preserves every desktop pixel including letterboxed edges', () => {
    const f = fixture({ width: 300, height: 200, scale: 0.5,
        left: 225, top: 150 });
    assert.deepEqual(result(f.get()), { minX: 0, minY: 0, maxX: 299, maxY: 199, clipped: false });
});

test('nested translated clients use the client box excluding borders and scrollbars', () => {
    const f = fixture({ viewLeft: 100, viewTop: 200, borderLeft: 4, borderTop: 6,
        viewWidth: 300, viewHeight: 180, left: -146, top: 81, scale: 1.25 });
    assert.deepEqual(result(f.get()), { minX: 200, minY: 100, maxX: 439, maxY: 243, clipped: true });
});

test('raw visual viewport clips browser pinch and keyboard area without scaling or page offset twice', () => {
    const f = fixture({ left: -100, top: -200, scale: 2 });
    const visual = { offsetLeft: 75, offsetTop: 60, width: 300, height: 220,
        pageLeft: 2075, pageTop: 3060, scale: 3 };
    assert.deepEqual(result(f.get(visual)), { minX: 88, minY: 130, maxX: 237, maxY: 239, clipped: true });
});

test('visual viewport intersects the actual client and cannot include its permanent control strip', () => {
    const f = fixture({ viewTop: 50, viewHeight: 350, top: 50 });
    assert.deepEqual(result(f.get({ offsetLeft: 0, offsetTop: 0, width: 768, height: 1024 })),
        { minX: 0, minY: 0, maxX: 599, maxY: 349, clipped: true });
    assert.deepEqual(result(f.get({ offsetLeft: 0, offsetTop: 0, width: 768, height: 300 })),
        { minX: 0, minY: 0, maxX: 599, maxY: 249, clipped: true });
});

test('fractional zoom rounds remote cursor anchors inside half-open CSS edges', () => {
    for (const scale of [0.5, 0.8, 1.25, 1.5, 2, 3]) {
        const left = -73.3;
        const top = -121.7;
        const f = fixture({ scale, left, top, viewLeft: 12.3, viewTop: 7.2,
            viewWidth: 233.8, viewHeight: 165.1 });
        const actual = f.get();
        assert(actual);
        assert(Number.isInteger(actual.minX) && Number.isInteger(actual.maxX));
        assert(Number.isInteger(actual.minY) && Number.isInteger(actual.maxY));
        assert(actual.minX * scale + left >= 12.3);
        assert(actual.minY * scale + top >= 7.2);
        assert(actual.maxX * scale + left < 12.3 + 233.8);
        assert(actual.maxY * scale + top < 7.2 + 165.1);
    }
});

test('partial clipping still reports clipped even when all integer cursor anchors fit', () => {
    const f = fixture({ width: 100, height: 100, scale: 2,
        viewWidth: 199.5, viewHeight: 200 });
    assert.deepEqual(result(f.get()), { minX: 0, minY: 0, maxX: 99, maxY: 99, clipped: true });
});

test('empty intersections and subpixel strips without an integer remote anchor have no bounds', () => {
    const f = fixture();
    assert.equal(f.get({ offsetLeft: 700, offsetTop: 0, width: 100, height: 100 }), null);
    assert.equal(fixture({ left: 700 }).get(), null);
    assert.equal(fixture({ top: 500 }).get(), null);
    assert.equal(fixture({ left: -0.2, scale: 2, viewWidth: 0.1 }).get(), null);
});

test('missing DOM geometry and invalid scales, dimensions, or viewport metrics fail safely', () => {
    const f = fixture();
    assert.equal(bounds.get({}, f.container, f.display), null);
    assert.equal(bounds.get(f.main, {}, f.display), null);
    for (const scale of [0, -1, NaN, Infinity])
        assert.equal(fixture({ scale }).get(), null);
    for (const width of [0, -1, NaN, Infinity, 10.5, Number.MAX_SAFE_INTEGER + 1])
        assert.equal(fixture({ width }).get(), null);
    for (const viewWidth of [0, -1, NaN, Infinity])
        assert.equal(fixture({ viewWidth }).get(), null);
    for (const visual of [
        { width: 0, height: 100 }, { width: 100, height: NaN },
        { width: 100, height: 100, offsetLeft: Infinity }
    ])
        assert.equal(f.get(visual), null);
    f.container.getBoundingClientRect = () => { throw new Error('detached view'); };
    assert.equal(f.get(), null);
});
