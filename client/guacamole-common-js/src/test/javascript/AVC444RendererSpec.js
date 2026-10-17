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

/* global Guacamole, expect, jasmine, pending */
describe('Guacamole AVC444 native sample copies', function() {
    function native(format, change) {
        var f = { format: format, codedWidth: 32, codedHeight: 34, visibleRect: { x: 0, y: 0, width: 16, height: 16 },
            copyTo: jasmine.createSpy('copyTo').and.callFake(function(data, options) {
                data.fill(101); return Promise.resolve(options.layout);
            }) };
        if (change) change(f); return f;
    }
    ['I420', 'NV12'].forEach(function(format) {
        it('copies original ' + format + ' planes with decoder margins, without requesting RGB conversion', async function() {
            var frame = native(format), result = await Guacamole.AVC444Renderer.copyFrame(frame, 16, 16);
            expect(result.width).toBe(16); expect(result.height).toBe(16); expect(result.format).toBe(format);
            var options = frame.copyTo.calls.mostRecent().args[1];
            expect(options.format).toBeUndefined(); expect(options.rect).toEqual({x:0,y:0,width:16,height:16});
            expect(result.planes[0].length).toBe(256); expect(result.planes[1].length).toBe(format === 'I420' ? 64 : 128);
            expect(result.planes[0][0]).toBe(101);
        });
    });
    it('honors returned plane offsets rather than assuming requested layouts were used', async function() {
        var frame = native('I420', function(f) { f.copyTo.and.callFake(function(data) {
            data.fill(4, 0, 256); data.fill(17, 256, 320); data.fill(29, 320);
            return Promise.resolve([{offset:0,stride:16},{offset:320,stride:8},{offset:256,stride:8}]);
        }); });
        var result = await Guacamole.AVC444Renderer.copyFrame(frame, 16, 16);
        expect(result.planes[1][0]).toBe(29); expect(result.planes[2][0]).toBe(17);
    });
    ['RGBA', 'BGRA', null, 'I420A'].forEach(function(format) {
        it('rejects lossy/opaque decoder format ' + format, async function() {
            var frame = native(format);
            await expectAsync(Guacamole.AVC444Renderer.copyFrame(frame, 16, 16)).toBeRejected(); expect(frame.copyTo).not.toHaveBeenCalled();
        });
    });
    [function(f) {f.visibleRect.width=15;}, function(f) {f.visibleRect.x=2;}, function(f) {f.codedHeight=15;}].forEach(function(change, i) {
        it('rejects inconsistent native rectangle ' + i, async function() {
            await expectAsync(Guacamole.AVC444Renderer.copyFrame(native('I420', change), 16, 16)).toBeRejected();
        });
    });
    [[{offset:0,stride:16}], [{offset:0,stride:16},{offset:256,stride:7},{offset:320,stride:8}],
        [{offset:0,stride:16},{offset:256,stride:8},{offset:321,stride:8}]].forEach(function(layout, i) {
        it('rejects invalid returned plane bounds ' + i, async function() {
            var frame = native('I420', function(f) { f.copyTo.and.returnValue(Promise.resolve(layout)); });
            await expectAsync(Guacamole.AVC444Renderer.copyFrame(frame, 16, 16)).toBeRejected();
        });
    });
});

describe('Guacamole AVC444 GPU color reconstruction', function() {
    it('reconstructs B-area parity, 16-row blocks and full-range BT.709 from I420 and NV12', function() {
        var probe = document.createElement('canvas').getContext('webgl2');
        if (!probe) {
            pending('Exact AVC444 GPU reconstruction requires WebGL2');
            return;
        }
        var extension = probe.getExtension('WEBGL_lose_context');
        if (extension) extension.loseContext();
        // A platform without WebGL2 cannot run this test. Once the context is
        // available, compilation, upload and pixel errors must remain failures.
        var w = 16, h = 32, n = w * h;
        var y = new Uint8Array(n), u = new Uint8Array(n), v = new Uint8Array(n);
        var main = {width:w,height:h,format:'I420',planes:[y,new Uint8Array(n/4),new Uint8Array(n/4)]};
        var aux = {width:w,height:h,format:'I420',planes:[new Uint8Array(n),new Uint8Array(n/4),new Uint8Array(n/4)]};
        for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
            var i = r*w+c; y[i]=70+r*3+c; u[i]=72+r*2+c*4; v[i]=180-r*2-c*3;
            if (r%2) {
                var row=Math.floor(Math.floor(r/2)/8)*16+Math.floor(r/2)%8;
                aux.planes[0][row*w+c]=u[i]; aux.planes[0][(row+8)*w+c]=v[i];
            }
        }
        for (var r = 0; r < h; r+=2) for (var c = 0; c < w; c+=2) {
            var i=r*w+c,j=r/2*(w/2)+c/2;
            main.planes[1][j]=Math.floor((u[i]+u[i+1]+u[i+w]+u[i+w+1])/4);
            main.planes[2][j]=Math.floor((v[i]+v[i+1]+v[i+w]+v[i+w+1])/4);
            aux.planes[1][j]=u[i+1]; aux.planes[2][j]=v[i+1];
        }
        var renderer = new Guacamole.AVC444Renderer(function() {});
        try {
            for (var mode=0;mode<2;mode++) {
                if (mode) [main,aux].forEach(function(frame) {
                    var uv=new Uint8Array(n/2);
                    for(var i=0;i<n/4;i++){uv[i*2]=frame.planes[1][i];uv[i*2+1]=frame.planes[2][i];}
                    frame.format='NV12';frame.planes=[frame.planes[0],uv];
                });
                var picture=renderer.render(main,aux,w,h,0);
                var canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
                var context=canvas.getContext('2d');context.drawImage(picture,0,0);picture.close();
                var data=context.getImageData(0,0,w,h).data;
                for(var r=0;r<h;r++)for(var c=0;c<w;c++) {
                    var i=r*w+c,uu=u[i]-128,vv=v[i]-128;
                    // The even/even U anti-alias average is exact for this
                    // pattern; V's integer average truncates by one half.
                    if (!(r%2) && !(c%2)) vv-=2;
                    var expected=[y[i]+1.5748*vv,y[i]-.187324*uu-.468124*vv,y[i]+1.8556*uu];
                    expected.forEach(function(value,k){expect(Math.abs(data[i*4+k]-Math.round(Math.max(0,Math.min(255,value))))).toBeLessThan(3);});
                    expect(data[i*4+3]).toBe(255);
                }
            }
        }
        finally {renderer.dispose();}
    });
});
