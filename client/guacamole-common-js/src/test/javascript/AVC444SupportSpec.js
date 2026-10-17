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

/* global Guacamole, jasmine, expect */
describe('Guacamole AVC444 capability safety', function() {
    var oldDecoder,oldChunk,oldFrame,oldRenderer,secureDescriptor,supported;
    beforeEach(function() {
        oldDecoder=window.VideoDecoder;oldChunk=window.EncodedVideoChunk;oldFrame=window.VideoFrame;oldRenderer=Guacamole.AVC444Renderer;
        secureDescriptor=Object.getOwnPropertyDescriptor(window,'isSecureContext');supported=Guacamole.AVC444VideoPlayer.supported;
        Guacamole.AVC444VideoPlayer.probe=null;
    });
    afterEach(function() {
        window.VideoDecoder=oldDecoder;window.EncodedVideoChunk=oldChunk;window.VideoFrame=oldFrame;Guacamole.AVC444Renderer=oldRenderer;
        Object.defineProperty(window,'isSecureContext',secureDescriptor);Guacamole.AVC444VideoPlayer.supported=supported;
    });
    it('never advertises outside a secure context or without native copy support',async function() {
        Object.defineProperty(window,'isSecureContext',{configurable:true,value:false});
        expect(await Guacamole.AVC444VideoPlayer.checkSupport()).toBe(false);
        Object.defineProperty(window,'isSecureContext',{configurable:true,value:true});window.VideoFrame=function(){};
        expect(await Guacamole.AVC444VideoPlayer.checkSupport()).toBe(false);
    });
    it('shares a bounded real probe and releases native/GPU state when decoding stalls',async function() {
        var closed=jasmine.createSpy('decoder close'),disposed=jasmine.createSpy('renderer dispose');
        window.VideoDecoder=function(){this.configure=function(){};this.decode=function(){};this.flush=function(){return new Promise(function(){});};this.close=closed;};
        Guacamole.AVC444Renderer=function(){this.dispose=disposed;};
        jasmine.clock().install();
        try {
            var first=Guacamole.AVC444VideoPlayer.checkSupport(),second=Guacamole.AVC444VideoPlayer.checkSupport();
            expect(first).toBe(second);jasmine.clock().tick(2001);
            expect(await first).toBe(false);expect(closed).toHaveBeenCalledTimes(1);expect(disposed).toHaveBeenCalledTimes(1);
            await Promise.resolve();expect(Guacamole.AVC444VideoPlayer.probe).toBe(null);
        }
        finally {jasmine.clock().uninstall();}
    });
});
