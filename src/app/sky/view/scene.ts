import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { altAzToWorld, radecToVec } from '../astro';
import type { BrightStar } from '../stars';

const GROUND_R = 9.5;
const HORIZON_R = 9.4;
const STAR_R = 9.9;

export interface Backdrop {
  group: Group;
  dispose(): void;
}

export function createBackdrop(): Backdrop {
  const group = new Group();

  const groundGeo = new SphereGeometry(GROUND_R, 64, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const groundMat = new MeshBasicMaterial({ color: new Color('#0a0d16'), side: DoubleSide });
  const ground = new Mesh(groundGeo, groundMat);
  ground.renderOrder = -10;
  group.add(ground);

  const lineMat = new LineBasicMaterial({ color: new Color('#c3cbd9'), transparent: true, opacity: 0.6 });

  const ring: number[] = [];
  const steps = 360;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push(Math.sin(a) * HORIZON_R, 0, -Math.cos(a) * HORIZON_R);
  }
  const ringGeo = new BufferGeometry();
  ringGeo.setAttribute('position', new BufferAttribute(new Float32Array(ring), 3));
  const horizon = new LineLoop(ringGeo, lineMat);
  horizon.renderOrder = 5;
  group.add(horizon);

  const ticks: number[] = [];
  const v0 = new Vector3();
  const v1 = new Vector3();
  for (let az = 0; az < 360; az += 30) {
    const len = az % 90 === 0 ? 2.2 : 1.2;
    altAzToWorld(0, az, v0).multiplyScalar(HORIZON_R);
    altAzToWorld(len, az, v1).multiplyScalar(HORIZON_R);
    ticks.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
  }
  const tickGeo = new BufferGeometry();
  tickGeo.setAttribute('position', new BufferAttribute(new Float32Array(ticks), 3));
  const tickLines = new LineSegments(tickGeo, lineMat);
  tickLines.renderOrder = 5;
  group.add(tickLines);

  return {
    group,
    dispose() {
      groundGeo.dispose();
      groundMat.dispose();
      ringGeo.dispose();
      tickGeo.dispose();
      lineMat.dispose();
    },
  };
}

const STAR_VERT = `
attribute float size;
attribute float bright;
uniform float uScale;
uniform float uRing;
varying float vBright;
void main() {
  vBright = bright;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (uRing > 0.5 ? size : size * 0.5 + 2.0) * uScale;
}
`;

const STAR_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRing;
varying float vBright;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (uRing < 0.5) {
    float da = (1.0 - smoothstep(0.35, 1.0, d)) * mix(0.3, 0.9, vBright);
    if (da < 0.01) discard;
    gl_FragColor = vec4(uColor, da);
    return;
  }
  float w = fwidth(d);
  float inner = smoothstep(0.78 - 0.1 - w, 0.78 - 0.1 + w, d);
  float outer = 1.0 - smoothstep(0.9 - w, 0.9 + w, d);
  float a = inner * outer * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export interface StarLayer {
  points: Points;
  named: { star: BrightStar; dir: Vector3 }[];
  setPixelRatio(r: number): void;
  setRing(on: boolean): void;
  dispose(): void;
}

export function createStarLayer(stars: BrightStar[]): StarLayer {
  const n = stars.length;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const bright = new Float32Array(n);
  const tmp = new Vector3();
  const named: { star: BrightStar; dir: Vector3 }[] = [];
  for (let i = 0; i < n; i++) {
    const s = stars[i];
    radecToVec(s.ra, s.dec, tmp);
    pos[i * 3] = tmp.x * STAR_R;
    pos[i * 3 + 1] = tmp.y * STAR_R;
    pos[i * 3 + 2] = tmp.z * STAR_R;
    size[i] = Math.max(8, Math.min(22, 8 + (6.5 - s.mag) * 1.7));
    bright[i] = Math.max(0, Math.min(1, (6.5 - s.mag) / 6.5));
    if (s.name) named.push({ star: s, dir: tmp.clone() });
  }
  named.sort((a, b) => a.star.mag - b.star.mag);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('size', new BufferAttribute(size, 1));
  geo.setAttribute('bright', new BufferAttribute(bright, 1));
  const mat = new ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: {
      uScale: { value: 1 },
      uRing: { value: 0 },
      uColor: { value: new Color('#e4e9f1') },
      uOpacity: { value: 0.7 },
    },
    transparent: true,
    depthWrite: false,
  });
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return {
    points,
    named,
    setPixelRatio(r) {
      mat.uniforms.uScale.value = r;
    },
    setRing(on) {
      mat.uniforms.uRing.value = on ? 1 : 0;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
