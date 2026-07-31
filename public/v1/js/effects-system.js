// js/effects-system.js
// ============================================================
//  نظام تأثيرات (Effects) ذاتي الاكتفاء بالكامل — بدون أي مكتبة خارجية:
//  (1) محرك Particle مبني يدوياً (محاكاة على المعالج + Shader مخصص بسيط
//      لدعم حجم/شفافية/لون مستقل لكل جسيم — PointsMaterial القياسية في
//      three.js لا تدعم ذلك لكل جسيم على حدة).
//  (2) تأثيرات مادة (Shader Material) بسيطة: توهّج (Glow) وتلاشي (Dissolve).
//
//  كل تأثير يوفّر واجهة موحّدة: play() / stop() / update(delta)، ويُسجَّل في
//  globalEffectRegistry ليُحدَّث تلقائياً كل إطار.
// ============================================================
import * as THREE from 'three';

function clampT(t) { return Math.max(0, Math.min(1, t)); }
function lerp(a, b, t) { return a + (b - a) * t; }

// ============================================================
//  1) محرك الجسيمات (Particle System)
// ============================================================
const PARTICLE_VERTEX_SHADER = `
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / max(-mvPosition.z, 0.001));
    gl_Position = projectionMatrix * mvPosition;
}
`;
const PARTICLE_FRAGMENT_SHADER = `
varying vec3 vColor;
varying float vAlpha;
void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float edge = smoothstep(0.5, 0.15, d);
    gl_FragColor = vec4(vColor, vAlpha * edge);
}
`;

// إعدادات جاهزة (Presets) — كل القيم قابلة للتعديل عبر options عند الإنشاء
export const PARTICLE_PRESETS = {
    fire: {
        rate: 45, maxParticles: 150, lifetime: [0.5, 1.0], size: [0.18, 0.02], alpha: [0.9, 0],
        colorStart: '#ffdd55', colorEnd: '#ff2200', additive: true,
        emitterShape: 'point', emitterRadius: 0.15,
        velocity: () => new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4),
        acceleration: new THREE.Vector3(0, 0.5, 0)
    },
    smoke: {
        rate: 10, maxParticles: 90, lifetime: [2, 3.5], size: [0.15, 0.7], alpha: [0.5, 0],
        colorStart: '#999999', colorEnd: '#555555', additive: false,
        emitterShape: 'point', emitterRadius: 0.1,
        velocity: () => new THREE.Vector3((Math.random() - 0.5) * 0.25, 0.5 + Math.random() * 0.35, (Math.random() - 0.5) * 0.25),
        acceleration: new THREE.Vector3(0, 0.05, 0)
    },
    rain: {
        rate: 180, maxParticles: 450, lifetime: [1, 1.3], size: [0.025, 0.025], alpha: [0.55, 0.4],
        colorStart: '#aaccff', colorEnd: '#aaccff', additive: false,
        emitterShape: 'box', emitterSize: [6, 0.3, 6], emitterOffsetY: 5,
        velocity: () => new THREE.Vector3((Math.random() - 0.5) * 0.1, -9 - Math.random() * 2, (Math.random() - 0.5) * 0.1),
        acceleration: new THREE.Vector3(0, 0, 0)
    },
    snow: {
        rate: 22, maxParticles: 220, lifetime: [4, 6.5], size: [0.06, 0.06], alpha: [0.9, 0.7],
        colorStart: '#ffffff', colorEnd: '#ffffff', additive: false,
        emitterShape: 'box', emitterSize: [6, 0.3, 6], emitterOffsetY: 5, drift: true,
        velocity: () => new THREE.Vector3((Math.random() - 0.5) * 0.3, -0.6 - Math.random() * 0.3, (Math.random() - 0.5) * 0.3),
        acceleration: new THREE.Vector3(0, 0, 0)
    },
    sparks: {
        rate: 55, maxParticles: 150, lifetime: [0.25, 0.55], size: [0.05, 0.01], alpha: [1, 0],
        colorStart: '#ffffaa', colorEnd: '#ff8800', additive: true,
        emitterShape: 'point', emitterRadius: 0.05,
        velocity: () => { const a = Math.random() * Math.PI * 2, s = 1.4 + Math.random() * 1.6; return new THREE.Vector3(Math.cos(a) * s, 1.3 + Math.random() * 1.4, Math.sin(a) * s); },
        acceleration: new THREE.Vector3(0, -4, 0)
    }
};

export class ParticleEffect {
    constructor(config, options = {}) {
        this.type = options._presetName || 'custom';
        this.config = { ...config, ...options };
        this.maxParticles = this.config.maxParticles || 150;
        this.particles = [];
        this.playing = false;
        this.intensity = options.intensity ?? 1;
        this.emitAccumulator = 0;
        this.anchor = null;
        this.position = new THREE.Vector3();
        this._originVec = new THREE.Vector3();

        const positions = new Float32Array(this.maxParticles * 3);
        const colors = new Float32Array(this.maxParticles * 3);
        const sizes = new Float32Array(this.maxParticles);
        const alphas = new Float32Array(this.maxParticles);

        this.geometry = new THREE.BufferGeometry();
        this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
        this.geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
        this.geometry.setDrawRange(0, 0);

        this.material = new THREE.ShaderMaterial({
            uniforms: {},
            vertexShader: PARTICLE_VERTEX_SHADER,
            fragmentShader: PARTICLE_FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            blending: this.config.additive ? THREE.AdditiveBlending : THREE.NormalBlending
        });

        this.points = new THREE.Points(this.geometry, this.material);
        this.points.frustumCulled = false;
        this.points.visible = false;
    }

    // يجعل التأثير يتبع كائناً (مثل النار الملتصقة بشمعة)، بدل موضع ثابت في العالم
    attachTo(object3D) {
        this.anchor = object3D;
        return this;
    }

    setWorldPosition(x, y, z) {
        this.anchor = null;
        this.position.set(x, y, z);
        return this;
    }

    setColor(hexStart, hexEnd) {
        this.config.colorStart = hexStart;
        if (hexEnd) this.config.colorEnd = hexEnd;
        return this;
    }

    setIntensity(v) {
        this.intensity = Math.max(0, v);
        return this;
    }

    play() { this.playing = true; this.points.visible = true; return this; }

    // stop() توقف انبعاث جسيمات جديدة فقط، والموجودة تتلاشى بشكل طبيعي
    stop() { this.playing = false; return this; }

    // إيقاف فوري كامل (بدون انتظار تلاشي الجسيمات المتبقية)
    stopImmediate() { this.playing = false; this.particles = []; this.points.visible = false; return this; }

    getSceneObject() { return this.points; }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
        if (this.points.parent) this.points.parent.remove(this.points);
    }

    _spawnParticle() {
        const cfg = this.config;
        const origin = this._originVec.clone();
        if (cfg.emitterShape === 'box') {
            const [w, h, d] = cfg.emitterSize || [1, 1, 1];
            origin.x += (Math.random() - 0.5) * w;
            origin.y += (cfg.emitterOffsetY || 0) + (Math.random() - 0.5) * h;
            origin.z += (Math.random() - 0.5) * d;
        } else {
            const r = cfg.emitterRadius || 0;
            const a = Math.random() * Math.PI * 2;
            const rr = r * Math.sqrt(Math.random());
            origin.x += Math.cos(a) * rr;
            origin.z += Math.sin(a) * rr;
        }
        const [lifeMin, lifeMax] = cfg.lifetime;
        const maxLife = lifeMin + Math.random() * (lifeMax - lifeMin);
        const sizeArr = Array.isArray(cfg.size) ? cfg.size : [cfg.size, cfg.size];
        const alphaArr = Array.isArray(cfg.alpha) ? cfg.alpha : [1, 0];
        return {
            position: origin,
            velocity: cfg.velocity(),
            life: maxLife,
            maxLife,
            sizeStart: sizeArr[0], sizeEnd: sizeArr[1],
            alphaStart: alphaArr[0], alphaEnd: alphaArr[1],
            phase: Math.random() * Math.PI * 2
        };
    }

    update(delta) {
        if (this.anchor) {
            this.anchor.getWorldPosition(this._originVec);
        } else {
            this._originVec.copy(this.position);
        }

        if (this.playing) {
            this.emitAccumulator += delta * this.config.rate * this.intensity;
            while (this.emitAccumulator >= 1 && this.particles.length < this.maxParticles) {
                this.particles.push(this._spawnParticle());
                this.emitAccumulator -= 1;
            }
        }

        const accel = this.config.acceleration;
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= delta;
            if (p.life <= 0) { this.particles.splice(i, 1); continue; }
            p.velocity.addScaledVector(accel, delta);
            p.position.addScaledVector(p.velocity, delta);
            if (this.config.drift) {
                p.position.x += Math.sin(p.phase + p.life * 3) * delta * 0.3;
            }
        }

        const posAttr = this.geometry.attributes.position;
        const colorAttr = this.geometry.attributes.aColor;
        const sizeAttr = this.geometry.attributes.aSize;
        const alphaAttr = this.geometry.attributes.aAlpha;
        const colorA = new THREE.Color(this.config.colorStart);
        const colorB = new THREE.Color(this.config.colorEnd);

        const n = Math.min(this.particles.length, this.maxParticles);
        for (let i = 0; i < n; i++) {
            const p = this.particles[i];
            const t = 1 - p.life / p.maxLife;
            posAttr.setXYZ(i, p.position.x, p.position.y, p.position.z);
            const c = colorA.clone().lerp(colorB, t);
            colorAttr.setXYZ(i, c.r, c.g, c.b);
            sizeAttr.setX(i, lerp(p.sizeStart, p.sizeEnd, t));
            alphaAttr.setX(i, lerp(p.alphaStart, p.alphaEnd, t));
        }
        posAttr.needsUpdate = true;
        colorAttr.needsUpdate = true;
        sizeAttr.needsUpdate = true;
        alphaAttr.needsUpdate = true;
        this.geometry.setDrawRange(0, n);

        this.points.visible = n > 0;
    }
}

// ============================================================
//  2) تأثير التوهّج (Glow) — شبكة إضافية شفافة أكبر قليلاً بحواف متوهجة
// ============================================================
const GLOW_VERTEX_SHADER = `
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
}
`;
const GLOW_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vNormal;
varying vec3 vViewDir;
void main() {
    float rim = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
    float glow = pow(rim, 2.0) * uIntensity;
    gl_FragColor = vec4(uColor * glow, glow);
}
`;

export class GlowEffect {
    constructor(targetObject, options = {}) {
        this.target = targetObject;
        this.color = options.color || '#66ccff';
        this.intensity = options.intensity ?? 1.5;
        this.pulse = options.pulse ?? true;
        this.playing = false;
        this._time = 0;

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(this.color) },
                uIntensity: { value: this.intensity }
            },
            vertexShader: GLOW_VERTEX_SHADER,
            fragmentShader: GLOW_FRAGMENT_SHADER,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.BackSide
        });

        this.mesh = new THREE.Mesh(targetObject.geometry, this.material);
        this.mesh.scale.setScalar(1.08);
        this.mesh.visible = false;
        targetObject.add(this.mesh);
    }

    play() { this.playing = true; this.mesh.visible = true; return this; }
    stop() { this.playing = false; this.mesh.visible = false; return this; }
    setColor(hex) { this.color = hex; this.material.uniforms.uColor.value.set(hex); return this; }
    setIntensity(v) { this.intensity = v; this.material.uniforms.uIntensity.value = v; return this; }
    getSceneObject() { return null; } // مضاف بالفعل كطفل للكائن الهدف

    update(delta) {
        if (!this.playing) return;
        this._time += delta;
        if (this.pulse) {
            this.material.uniforms.uIntensity.value = this.intensity * (0.8 + 0.2 * Math.sin(this._time * 3));
        }
    }

    dispose() {
        this.target.remove(this.mesh);
        this.material.dispose();
    }
}

// ============================================================
//  3) تأثير التلاشي (Dissolve) — يستبدل مادة الهدف مؤقتاً بمادة تلاشٍ
//     تعتمد ضوضاء إجرائية (بدون أي texture خارجية)
// ============================================================
const DISSOLVE_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const DISSOLVE_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform vec3 uEdgeColor;
uniform float uProgress;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
void main() {
    float n = noise(vUv * 14.0) * 0.7 + noise(vUv * 30.0) * 0.3;
    if (n < uProgress) discard;
    float edge = smoothstep(uProgress, uProgress + 0.1, n);
    vec3 color = mix(uEdgeColor, uColor, edge);
    gl_FragColor = vec4(color, 1.0);
}
`;

export class DissolveEffect {
    constructor(targetObject, options = {}) {
        this.target = targetObject;
        this.originalMaterial = targetObject.material;
        this.duration = options.duration ?? 1.5;
        this.edgeColor = options.edgeColor || '#ff8800';
        this.playing = false;
        this._time = 0;
        this._direction = 1; // 1 = يختفي تدريجياً، -1 = يتكوّن/يظهر تدريجياً

        const baseColor = (this.originalMaterial && this.originalMaterial.color)
            ? this.originalMaterial.color : new THREE.Color(0xffffff);

        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: baseColor.clone() },
                uEdgeColor: { value: new THREE.Color(this.edgeColor) },
                uProgress: { value: 0 }
            },
            vertexShader: DISSOLVE_VERTEX_SHADER,
            fragmentShader: DISSOLVE_FRAGMENT_SHADER,
            transparent: false
        });
    }

    // direction=1: تلاشي للاختفاء، direction=-1: تكوّن للظهور
    play(direction = 1) {
        this._direction = direction;
        this.target.material = this.material;
        this.material.uniforms.uProgress.value = direction === 1 ? 0 : 1;
        this._time = 0;
        this.playing = true;
        this.target.visible = true;
        return this;
    }

    stop() {
        this.playing = false;
        this.target.material = this.originalMaterial;
        return this;
    }

    getSceneObject() { return null; }

    update(delta) {
        if (!this.playing) return;
        this._time += delta;
        const t = clampT(this._time / this.duration);
        this.material.uniforms.uProgress.value = this._direction === 1 ? t : 1 - t;
        if (t >= 1) {
            this.playing = false;
            if (this._direction === 1) {
                this.target.visible = false;
            } else {
                this.target.material = this.originalMaterial;
            }
        }
    }

    dispose() {
        this.material.dispose();
    }
}

// ============================================================
//  سجلّ عام + دالة مصنع موحّدة
// ============================================================
export class EffectRegistry {
    constructor() { this.effects = new Set(); }
    register(effect) { this.effects.add(effect); }
    unregister(effect) { this.effects.delete(effect); }
    update(delta) { this.effects.forEach(e => e.update(delta)); }
}
export const globalEffectRegistry = new EffectRegistry();

/**
 * دالة مصنع موحّدة لإنشاء أي نوع تأثير بالاسم.
 * @param {string} type اسم preset جسيمي (fire/smoke/rain/snow/sparks) أو 'glow'/'dissolve'
 * @param {THREE.Object3D} target الكائن الهدف (يُستخدم كنقطة انبعاث/حامل للتأثير)
 */
export function createEffect(type, target, options = {}) {
    let effect;
    if (PARTICLE_PRESETS[type]) {
        effect = new ParticleEffect(PARTICLE_PRESETS[type], { ...options, _presetName: type });
        if (target && target.isObject3D) effect.attachTo(target);
    } else if (type === 'glow') {
        effect = new GlowEffect(target, options);
    } else if (type === 'dissolve') {
        effect = new DissolveEffect(target, options);
    } else {
        throw new Error(`Unknown effect type: ${type}`);
    }
    globalEffectRegistry.register(effect);
    return effect;
}

/**
 * يبني object.effects = { name: EffectInstance } من بيانات محفوظة على
 * الكائن (object.userData.effectsData)، مطابقاً لنمط buildAnimationsForObject.
 * يحتاج scene لإضافة أي عناصر عرض خاصة بالتأثير (مثل نقاط الجسيمات).
 */
export function buildEffectsForObject(object, scene) {
    const effectsData = object.userData.effectsData || {};
    if (object.effects) {
        Object.values(object.effects).forEach(e => {
            globalEffectRegistry.unregister(e);
            if (e.dispose) e.dispose();
        });
    }
    object.effects = {};

    Object.keys(effectsData).forEach(name => {
        const cfg = effectsData[name];
        const effect = createEffect(cfg.type, object, cfg.options || {});
        const sceneObj = effect.getSceneObject ? effect.getSceneObject() : null;
        if (sceneObj && scene) scene.add(sceneObj);
        object.effects[name] = effect;
    });

    return object.effects;
}
