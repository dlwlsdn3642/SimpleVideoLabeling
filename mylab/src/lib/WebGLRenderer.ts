export default class WebGLRenderer {
  private gl: WebGL2RenderingContext | WebGLRenderingContext;
  private program: WebGLProgram;
  private vao?: WebGLVertexArrayObject | null;
  private baseSamplerLoc: WebGLUniformLocation | null;
  private overlaySamplerLoc: WebGLUniformLocation | null;
  private baseTex: WebGLTexture;
  private overlayTex: WebGLTexture;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl2 = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true });
    const gl = (gl2 || canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true })) as WebGL2RenderingContext | WebGLRenderingContext | null;
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    const vsSrc = `#version 300 es
      in vec2 a_pos; in vec2 a_uv; out vec2 v_uv; void main(){ v_uv=a_uv; gl_Position=vec4(a_pos,0.0,1.0);} `;
    const fsSrc = `#version 300 es
      precision mediump float; in vec2 v_uv; uniform sampler2D u_base; uniform sampler2D u_overlay; out vec4 o;
      void main(){ vec4 b=texture(u_base,v_uv); vec4 ovr=texture(u_overlay,v_uv); o = ovr.a > 0.0 ? (ovr + (1.0-ovr.a)*b) : b; }
    `;
    const isGL2 = !!gl2;
    const vs = this.createShader(isGL2 ? gl as WebGL2RenderingContext : gl, isGL2 ? (gl as WebGL2RenderingContext).VERTEX_SHADER : (gl as WebGLRenderingContext).VERTEX_SHADER, isGL2 ? vsSrc : vsSrc.replace('#version 300 es\n', ''));
    const fs = this.createShader(isGL2 ? gl as WebGL2RenderingContext : gl, isGL2 ? (gl as WebGL2RenderingContext).FRAGMENT_SHADER : (gl as WebGLRenderingContext).FRAGMENT_SHADER,
      isGL2 ? fsSrc : `precision mediump float; varying vec2 v_uv; uniform sampler2D u_base; uniform sampler2D u_overlay; void main(){ vec4 b=texture2D(u_base,v_uv); vec4 ovr=texture2D(u_overlay,v_uv); gl_FragColor = ovr.a>0.0 ? (ovr + (1.0-ovr.a)*b) : b; }`);
    const prog = gl.createProgram(); if (!prog) throw new Error('prog');
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link failed');
    this.program = prog;

    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    const uvLoc = gl.getAttribLocation(prog, 'a_uv');
    this.baseSamplerLoc = gl.getUniformLocation(prog, 'u_base');
    this.overlaySamplerLoc = gl.getUniformLocation(prog, 'u_overlay');

    const quad = new Float32Array([
      -1, -1, 0, 0,
      +1, -1, 1, 0,
      -1, +1, 0, 1,
      +1, +1, 1, 1,
    ]);
    const buf = gl.createBuffer(); if (!buf) throw new Error('vbo');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    if ((gl as WebGL2RenderingContext).createVertexArray) {
      const vao = (gl as WebGL2RenderingContext).createVertexArray();
      (gl as WebGL2RenderingContext).bindVertexArray(vao);
      gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
      this.vao = vao;
    } else {
      gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
    }

    const baseTex = gl.createTexture(); const overlayTex = gl.createTexture();
    if (!baseTex || !overlayTex) throw new Error('textures');
    this.baseTex = baseTex; this.overlayTex = overlayTex;

    gl.useProgram(this.program);
    gl.uniform1i(this.baseSamplerLoc, 0);
    gl.uniform1i(this.overlaySamplerLoc, 1);
    gl.clearColor(0.07, 0.07, 0.07, 1);
  }

  private createShader(gl: any, type: number, src: string) {
    const sh = gl.createShader(type); if (!sh) throw new Error('shader');
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  draw(base: HTMLImageElement | ImageBitmap | HTMLCanvasElement, overlay?: HTMLCanvasElement) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // @ts-ignore - overloads accept ImageBitmap/Canvas
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, base);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (overlay) {
      // @ts-ignore
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
    } else {
      // upload 1x1 transparent
      const px = new Uint8Array([0,0,0,0]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1,1,0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }

    gl.useProgram(this.program);
    if (this.vao) (this.gl as WebGL2RenderingContext).bindVertexArray(this.vao);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {}
  }
}
