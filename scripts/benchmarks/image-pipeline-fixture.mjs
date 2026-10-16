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
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
const requireValue = (value, message) => { if (!value) throw new Error('Invalid image fixture: ' + message); };

export async function readFixture(filename) {
    requireValue((await stat(filename)).size <= 128 * 1024 * 1024, 'file exceeds128MiB');
    const text = await readFile(filename, 'utf8');
    return validateFixture(JSON.parse(text), sha256(text));
}

export function validateFixture(fixture, fileHash = null) {
    requireValue(fixture && fixture.schema === 'guacamole-image-pipeline-fixture-v1', 'schema');
    requireValue(fixture.provenance && typeof fixture.provenance === 'object'
        && !Array.isArray(fixture.provenance), 'provenance');
    requireValue(Array.isArray(fixture.assets) && fixture.assets.length > 0 && fixture.assets.length <= 512, 'asset count');
    const assets = new Map();
    let encodedBytes = 0, decodedAssetBytes = 0;
    for (const asset of fixture.assets) {
        requireValue(id(asset.id) && !assets.has(asset.id), 'asset id');
        requireValue(['image/png', 'image/webp'].includes(asset.mimetype), 'asset MIME type');
        requireValue(integer(asset.width, 1, 8192) && integer(asset.height, 1, 8192)
            && asset.width * asset.height <= 16777216, 'asset dimensions');
        decodedAssetBytes += asset.width * asset.height * 4;
        requireValue(decodedAssetBytes <= 192 * 1024 * 1024, 'decoded asset storage exceeds192MiB');
        requireValue(typeof asset.data_base64 === 'string' && asset.data_base64.length > 0
            && asset.data_base64.length <= 24 * 1024 * 1024
            && asset.data_base64.length % 4 === 0
            && !/[^A-Za-z0-9+/=]/.test(asset.data_base64), 'canonical Base64');
        const bytes = Buffer.from(asset.data_base64, 'base64');
        requireValue(bytes.toString('base64') === asset.data_base64, 'noncanonical Base64 pad bits');
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
        requireValue(asset.mimetype === 'image/png' ? png : webp, 'codec signature');
        requireValue(asset.encode_ms === null || asset.encode_ms === undefined
            || (Number.isFinite(asset.encode_ms) && asset.encode_ms >= 0), 'encoder timing');
        requireValue(!asset.encoded_sha256 || asset.encoded_sha256 === sha256(bytes), 'encoded payload hash');
        encodedBytes += bytes.length; requireValue(encodedBytes <= 96 * 1024 * 1024, 'encoded bytes exceed96MiB');
        assets.set(asset.id, asset);
    }
    requireValue(Array.isArray(fixture.scenarios) && fixture.scenarios.length > 0 && fixture.scenarios.length <= 32, 'scenario count');
    const ids = new Set();
    for (const scenario of fixture.scenarios) {
        requireValue(id(scenario.id) && !ids.has(scenario.id), 'scenario id'); ids.add(scenario.id);
        requireValue(integer(scenario.width, 1, 8192) && integer(scenario.height, 1, 8192)
            && scenario.width * scenario.height <= 16777216, 'scenario dimensions');
        requireValue(Array.isArray(scenario.frames) && scenario.frames.length > 0 && scenario.frames.length <= 16
            && scenario.frames.length * scenario.width * scenario.height * 4 <= 128 * 1024 * 1024, 'bounded oracle storage');
        for (const frame of scenario.frames) {
            requireValue(Array.isArray(frame.images) && frame.images.length > 0 && frame.images.length <= 512, 'frame image count');
            let area = 0;
            const rectangles = [];
            for (const image of frame.images) {
                const asset = assets.get(image.asset);
                requireValue(asset && integer(image.x, 0, scenario.width - 1) && integer(image.y, 0, scenario.height - 1)
                    && image.x + asset.width <= scenario.width && image.y + asset.height <= scenario.height, 'image placement');
                const rectangle = { x: image.x, y: image.y, width: asset.width, height: asset.height };
                for (const other of rectangles) requireValue(rectangle.x + rectangle.width <= other.x || other.x + other.width <= rectangle.x
                    || rectangle.y + rectangle.height <= other.y || other.y + other.height <= rectangle.y, 'overlapping images');
                rectangles.push(rectangle); area += asset.width * asset.height;
            }
            // Full-cover frames make the independent per-template oracle valid
            // across repeated variants, without resetting the actual display.
            requireValue(area === scenario.width * scenario.height, 'frame must cover canvas exactly');
        }
    }
    return { fixture, assets, sha256: fileHash || sha256(JSON.stringify(fixture)), encoded_bytes: encodedBytes,
        geometry_sha256: sha256(JSON.stringify({ scenarios: fixture.scenarios,
            assets: fixture.assets.map(({ id, mimetype, width, height }) => ({ id, mimetype, width, height })) })),
        asset_summary: fixture.assets.map(asset => ({ id: asset.id, mimetype: asset.mimetype, width: asset.width,
            height: asset.height, encoded_bytes: Buffer.byteLength(asset.data_base64, 'base64'),
            encoded_sha256: sha256(Buffer.from(asset.data_base64, 'base64')), encode_ms: asset.encode_ms ?? null })) };
}
