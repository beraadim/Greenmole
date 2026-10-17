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

var Guacamole = Guacamole || {};

/**
 * Exact-plane AVC444v1 reconstruction. The two AVC subframes are YUV420,
 * not RGB pictures: converting them to RGB first irreversibly clips the
 * auxiliary chroma values. Keep native I420/NV12 samples through copyTo(),
 * then perform the B-area mapping and full-range BT.709 conversion on GPU.
 *
 * @constructor
 * @param {!function()} onerror Called if the private context is lost.
 */
Guacamole.AVC444Renderer = function AVC444Renderer(onerror) {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false,
        depth: false, stencil: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('AVC444 requires WebGL2');
    var closed = false;
    canvas.addEventListener('webglcontextlost', function lost(event) {
        event.preventDefault();
        if (!closed && onerror) onerror();
    });
    var textures = [], shaders = [], program = null;
    function shader(type, source) {
        var value = gl.createShader(type);
        shaders.push(value);
        gl.shaderSource(value, source);
        gl.compileShader(value);
        if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error('AVC444 shader compilation failed: ' + gl.getShaderInfoLog(value));
        return value;
    }
    try {
        program = gl.createProgram();
        gl.attachShader(program, shader(gl.VERTEX_SHADER, '#version 300 es\n'
            + 'void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));'
            + 'gl_Position=vec4(p*2.0-1.0,0.0,1.0);}'));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, '#version 300 es\n'
            + 'precision highp float;precision highp int;precision highp sampler2D;\n'
            + 'uniform sampler2D mainY;uniform sampler2D mainU;uniform sampler2D mainV;'
            + 'uniform sampler2D auxY;uniform sampler2D auxU;uniform sampler2D auxV;'
            + 'uniform bool mainNV12;uniform bool auxNV12;uniform int visibleHeight;out vec4 color;'
            + 'vec2 mainChroma(ivec2 p){return vec2(texelFetch(mainU,p,0).r,'
            + 'mainNV12?texelFetch(mainU,p,0).g:texelFetch(mainV,p,0).r);}'
            + 'vec2 auxChroma(ivec2 p){return vec2(texelFetch(auxU,p,0).r,'
            + 'auxNV12?texelFetch(auxU,p,0).g:texelFetch(auxV,p,0).r);}'
            + 'vec2 oddChroma(int x,int y){int r=(y/2/8)*16+(y/2)%8;'
            + 'return vec2(texelFetch(auxY,ivec2(x,r),0).r,texelFetch(auxY,ivec2(x,r+8),0).r);}'
            + 'void main(){ivec2 p=ivec2(int(gl_FragCoord.x),visibleHeight-1-int(gl_FragCoord.y));'
            + 'vec2 uv;if((p.y&1)==1)uv=oddChroma(p.x,p.y);'
            + 'else if((p.x&1)==1)uv=auxChroma(p/2);'
            // Invert the main view's 2x2 anti-alias filter for the omitted
            // even/even sample. Never feed this reconstructed value back into
            // a later frame; every accepted envelope contains both full views.
            + 'else uv=clamp(4.0*mainChroma(p/2)-auxChroma(p/2)'
            + '-oddChroma(p.x,p.y+1)-oddChroma(p.x+1,p.y+1),0.0,1.0);'
            + 'float y=texelFetch(mainY,p,0).r;uv-=vec2(128.0/255.0);'
            + 'color=vec4(y+1.5748*uv.y,y-0.187324*uv.x-0.468124*uv.y,y+1.8556*uv.x,1.0);}'));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('AVC444 shader linking failed');
        gl.useProgram(program);
        ['mainY', 'mainU', 'mainV', 'auxY', 'auxU', 'auxV'].forEach(function texture(name, i) {
            var value = gl.createTexture(); textures.push(value);
            gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, value);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.uniform1i(gl.getUniformLocation(program, name), i);
        });
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }
    catch (error) { dispose(); throw error; }
    function dispose() {
        if (closed) return;
        closed = true;
        textures.forEach(function remove(value) { gl.deleteTexture(value); });
        shaders.forEach(function remove(value) { gl.deleteShader(value); });
        if (program) gl.deleteProgram(program);
        var extension = gl.getExtension('WEBGL_lose_context');
        if (extension) extension.loseContext();
        canvas.width = canvas.height = 1;
    }
    this.dispose = dispose;
    this.render = function render(main, auxiliary, width, height, timestamp) {
        if (closed || gl.isContextLost() || main.width !== auxiliary.width || main.height !== auxiliary.height
                || main.width !== Math.ceil(width / 16) * 16 || main.height !== Math.ceil(height / 16) * 16)
            throw new Error('Invalid AVC444 coded dimensions');
        if (main.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || main.height > gl.getParameter(gl.MAX_TEXTURE_SIZE))
            throw new Error('AVC444 exceeds texture limits');
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        gl.viewport(0, 0, width, height); gl.useProgram(program);
        [main, auxiliary].forEach(function upload(frame, side) {
            for (var p = 0; p < 3; p++) {
                var plane = frame.planes[p], channels = p === 1 && frame.format === 'NV12' ? 2 : 1;
                var w = p ? frame.width / 2 : frame.width, h = p ? frame.height / 2 : frame.height;
                gl.activeTexture(gl.TEXTURE0 + side * 3 + p); gl.bindTexture(gl.TEXTURE_2D, textures[side * 3 + p]);
                // The unused V texture must still be complete in NV12 mode.
                if (!plane) { w = h = 1; plane = new Uint8Array(1); }
                gl.texImage2D(gl.TEXTURE_2D, 0, channels === 2 ? gl.RG8 : gl.R8, w, h, 0,
                    channels === 2 ? gl.RG : gl.RED, gl.UNSIGNED_BYTE, plane);
            }
            gl.uniform1i(gl.getUniformLocation(program, side ? 'auxNV12' : 'mainNV12'), frame.format === 'NV12' ? 1 : 0);
        });
        gl.uniform1i(gl.getUniformLocation(program, 'visibleHeight'), height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw new Error('AVC444 rendering failed');
        // VideoFrame snapshots the owned canvas. Ordered presentation may wait
        // behind an earlier image while the next pair reuses these textures.
        return new window.VideoFrame(canvas, { timestamp: timestamp, alpha: 'discard' });
    };
};

/** Copy native decoder samples without requesting an RGB/color conversion. */
Guacamole.AVC444Renderer.copyFrame = function copyFrame(frame, width, height) {
    var format = frame.format, rect = frame.visibleRect;
    var w = Math.ceil(width / 16) * 16, h = Math.ceil(height / 16) * 16;
    // codedWidth/Height describe platform allocations, which may include decoder
    // margins beyond the actual SPS picture. Copy only the validated visible
    // picture (the encoder's padded canvas), preserving its native YUV values.
    if ((format !== 'I420' && format !== 'NV12') || !rect || rect.x !== 0 || rect.y !== 0
            || rect.width !== w || rect.height !== h || frame.codedWidth < w || frame.codedHeight < h
            || frame.codedWidth > 8256 || frame.codedHeight > 8256 || w * h > 16777216)
        return Promise.reject(new Error('Unsupported AVC444 native frame layout'));
    var y = w * h, size = y * 3 / 2;
    var layout = [{ offset: 0, stride: w }, { offset: y, stride: format === 'NV12' ? w : w / 2 }];
    if (format === 'I420') layout.push({ offset: y * 5 / 4, stride: w / 2 });
    var data = new Uint8Array(size);
    var options = { rect: { x: 0, y: 0, width: w, height: h }, layout: layout };
    return Promise.resolve().then(function copy() { return frame.copyTo(data, options); }).then(function copied(actual) {
        if (!actual || actual.length !== layout.length) throw new Error('Invalid AVC444 plane count');
        var planes = actual.map(function plane(p, index) {
            var rowBytes = index ? (format === 'NV12' ? w : w / 2) : w, rows = index ? h / 2 : h;
            if (!Number.isSafeInteger(p.offset) || !Number.isSafeInteger(p.stride) || p.offset < 0
                    || p.stride < rowBytes || p.offset + (rows - 1) * p.stride + rowBytes > data.length)
                throw new Error('Invalid AVC444 plane bounds');
            if (p.stride === rowBytes) return data.subarray(p.offset, p.offset + rowBytes * rows);
            var packed = new Uint8Array(rowBytes * rows);
            for (var r = 0; r < rows; r++) packed.set(data.subarray(p.offset + r * p.stride, p.offset + r * p.stride + rowBytes), r * rowBytes);
            return packed;
        });
        return { width: w, height: h, format: format, planes: planes };
    });
};
