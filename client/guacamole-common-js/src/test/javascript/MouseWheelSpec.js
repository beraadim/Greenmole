/*
 * Modified for Greenmole by its maintainers.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* global Guacamole, jasmine, expect */
describe('Guacamole horizontal mouse wheel', function() {
    var client, tunnel, sent;

    beforeEach(function() {
        sent = [];
        tunnel = new Guacamole.Tunnel();
        tunnel.connect = jasmine.createSpy('synthetic connect');
        tunnel.disconnect = jasmine.createSpy('synthetic disconnect');
        tunnel.isConnected = function() { return true; };
        tunnel.sendMessage = function() { sent.push(Array.from(arguments)); };
        client = new Guacamole.Client(tunnel);
        client.connect('synthetic');
    });

    afterEach(function() { client.disconnect(); });

    function mouse() { return sent.filter(function(message) { return message[0] === 'mouse'; }); }

    it('preserves horizontal wheel state independently of ordinary buttons and legacy construction', function() {
        var horizontal = new Guacamole.Mouse.State({ x: 10, y: 20, scrollLeft: true });
        expect(horizontal.scrollLeft).toBe(true);
        expect(horizontal.scrollRight).toBe(false);
        expect(horizontal.left).toBe(false);
        expect(horizontal.right).toBe(false);
        expect(new Guacamole.Mouse.State(horizontal).scrollLeft).toBe(true);
        var legacy = new Guacamole.Mouse.State(1, 2, true, false, false, false, true);
        expect(legacy.left).toBe(true);
        expect(legacy.down).toBe(true);
        expect(legacy.scrollLeft).toBe(false);
        expect(legacy.scrollRight).toBe(false);
    });

    it('sends distinct horizontal press/release masks without synthesizing clicks', function() {
        client.sendMouseState({ x: 10.9, y: 20.9, scrollLeft: true });
        client.sendMouseState({ x: 10.9, y: 20.9 });
        client.sendMouseState({ x: 10.9, y: 20.9, scrollRight: true });
        client.sendMouseState({ x: 10.9, y: 20.9 });
        expect(mouse()).toEqual([
            ['mouse', 10, 20, 32], ['mouse', 10, 20, 0],
            ['mouse', 10, 20, 64], ['mouse', 10, 20, 0]
        ]);
    });

    it('preserves held buttons and vertical wheel bits, scales once, and drops disconnected input', function() {
        client.getDisplay().scale(2);
        client.sendMouseState({ x: 21, y: 43, left: true, down: true, scrollRight: true }, true);
        expect(mouse()).toEqual([['mouse', 10, 21, 81]]);
        client.disconnect();
        client.sendMouseState({ x: 5, y: 6, scrollLeft: true });
        expect(mouse().length).toBe(1);
    });
});
