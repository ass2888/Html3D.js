// js/animation-system.js
// ============================================================
//  نظام حركة (Animation) خفيف مبني خصيصاً لهذا المشروع — بدون الاعتماد على
//  THREE.AnimationMixer لأننا نحتاج مسارات غير قياسية (visible/opacity/color)
//  وتنسيق SCAD مخصص، فكان بناء محرك تشغيل بسيط أوضح وأسهل صيانة.
//
//  البيانات (AnimationClip) قابلة للتسلسل الكامل إلى/من نص SCAD، وتُشغَّل عبر
//  AnimationPlayer الذي يوفّر: play() / pause() / stop() — تماماً كما طلب
//  المستخدم: mesh.animations.rolling.play()
// ============================================================
import * as THREE from 'three';

// ===== الأنواع المدعومة لكل مسار (track) =====
// position / scale : [x,y,z] بالوحدات المكانية، تُقارَب خطياً (lerp)
// rotation         : [x,y,z] بالدرجات (نفس اصطلاح rotate() في SCAD)، تُقارَب
//                     عبر quaternion slerp لتفادي أي التفاف غريب (gimbal)
// color            : "#rrggbb"، يُقارَب في فضاء RGB خطياً
// opacity          : رقم 0..1، يُقارَب خطياً
// visible          : true/false — قيمة "خطوة" (step) بلا تقريب، وهي ما
//                     يُمثّل عملياً "إنشاء/حذف" الشكل أثناء الحركة

const LERP_TRACKS = new Set(['position', 'scale', 'opacity', 'color']);

function clampT(t) { return Math.max(0, Math.min(1, t)); }

// يبحث عن الإطارين المحيطين بزمن معيّن داخل مسار (مرتّب حسب t تصاعدياً)
function findSurroundingKeyframes(track, time) {
    if (!track || track.length === 0) return null;
    if (track.length === 1) return { a: track[0], b: track[0], t: 0 };
    if (time <= track[0].t) return { a: track[0], b: track[0], t: 0 };
    if (time >= track[track.length - 1].t) {
        const last = track[track.length - 1];
        return { a: last, b: last, t: 0 };
    }
    for (let i = 0; i < track.length - 1; i++) {
        const a = track[i], b = track[i + 1];
        if (time >= a.t && time <= b.t) {
            const span = (b.t - a.t) || 1;
            return { a, b, t: clampT((time - a.t) / span) };
        }
    }
    return { a: track[0], b: track[0], t: 0 };
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpColor(hexA, hexB, t) {
    const ca = new THREE.Color(hexA), cb = new THREE.Color(hexB);
    const result = ca.clone().lerp(cb, t);
    return '#' + result.getHexString();
}

/**
 * بيانات حركة واحدة (Clip) — قابلة للتسلسل الكامل، تُخزَّن داخل
 * object.userData.animationClips وتُصدَّر إلى SCAD.
 */
export class AnimationClip {
    constructor(name, { duration = 1, loop = false } = {}) {
        this.name = name;
        this.duration = duration;
        this.loop = loop;
        // كل مسار: مصفوفة { t: seconds, value } مرتّبة تصاعدياً حسب t
        this.tracks = { position: [], rotation: [], scale: [], color: [], opacity: [], visible: [] };
    }

    // يُدرج/يُحدّث إطاراً مفتاحياً في مسار معيّن عند زمن معيّن
    setKeyframe(trackName, time, value) {
        const track = this.tracks[trackName];
        if (!track) return;
        const existing = track.find(k => Math.abs(k.t - time) < 1e-4);
        if (existing) {
            existing.value = value;
        } else {
            track.push({ t: time, value });
            track.sort((a, b) => a.t - b.t);
        }
    }

    removeKeyframe(trackName, time) {
        const track = this.tracks[trackName];
        if (!track) return;
        const idx = track.findIndex(k => Math.abs(k.t - time) < 1e-4);
        if (idx !== -1) track.splice(idx, 1);
    }

    hasAnyKeyframes() {
        return Object.values(this.tracks).some(t => t.length > 0);
    }

    toJSON() {
        return { name: this.name, duration: this.duration, loop: this.loop, tracks: this.tracks };
    }

    static fromJSON(json) {
        const clip = new AnimationClip(json.name, { duration: json.duration, loop: json.loop });
        clip.tracks = json.tracks;
        return clip;
    }
}

/**
 * محرّك تشغيل حركة واحدة مرتبطة بكائن THREE.Object3D (عادة Mesh).
 * تُنشأ نسخة واحدة لكل (clip × object)، وتُعرَض على object.animations[name]
 */
export class AnimationPlayer {
    constructor(object, clip) {
        this.object = object;
        this.clip = clip;
        this.playing = false;
        this.paused = false;
        this.currentTime = 0;
        this.onComplete = null; // callback اختياري
        // نتذكر الحالة الأصلية (قبل أي تشغيل) لإعادة الجسم إليها عند stop()
        this._baseState = null;
    }

    _captureBaseState() {
        const obj = this.object;
        this._baseState = {
            position: obj.position.toArray(),
            rotation: [THREE.MathUtils.radToDeg(obj.rotation.x), THREE.MathUtils.radToDeg(obj.rotation.y), THREE.MathUtils.radToDeg(obj.rotation.z)],
            scale: obj.scale.toArray(),
            color: (obj.material && obj.material.color) ? '#' + obj.material.color.getHexString() : null,
            opacity: (obj.material) ? obj.material.opacity : null,
            visible: obj.visible
        };
    }

    play() {
        if (!this._baseState) this._captureBaseState();
        this.playing = true;
        this.paused = false;
        if (this.currentTime >= this.clip.duration) this.currentTime = 0;
        return this;
    }

    pause() {
        this.paused = true;
        return this;
    }

    resume() {
        if (this.playing) this.paused = false;
        return this;
    }

    stop() {
        this.playing = false;
        this.paused = false;
        this.currentTime = 0;
        if (this._baseState) this._applyState(this._baseState);
        return this;
    }

    seek(time) {
        this.currentTime = Math.max(0, Math.min(this.clip.duration, time));
        this._evaluate(this.currentTime);
        return this;
    }

    _applyState(state) {
        const obj = this.object;
        obj.position.fromArray(state.position);
        obj.rotation.set(
            THREE.MathUtils.degToRad(state.rotation[0]),
            THREE.MathUtils.degToRad(state.rotation[1]),
            THREE.MathUtils.degToRad(state.rotation[2])
        );
        obj.scale.fromArray(state.scale);
        if (obj.material && state.color) obj.material.color.set(state.color);
        if (obj.material && state.opacity !== null && state.opacity !== undefined) {
            obj.material.opacity = state.opacity;
            obj.material.transparent = state.opacity < 1;
        }
        obj.visible = state.visible;
    }

    /** يُستدعى مرة كل إطار من حلقة الرسم الرئيسية لكل اللاعبين النشطين */
    update(delta) {
        if (!this.playing || this.paused) return;
        this.currentTime += delta;
        if (this.currentTime >= this.clip.duration) {
            if (this.clip.loop) {
                this.currentTime = this.clip.duration > 0 ? (this.currentTime % this.clip.duration) : 0;
            } else {
                this.currentTime = this.clip.duration;
                this.playing = false;
                this._evaluate(this.currentTime);
                if (this.onComplete) this.onComplete();
                return;
            }
        }
        this._evaluate(this.currentTime);
    }

    _evaluate(time) {
        const obj = this.object;
        const tracks = this.clip.tracks;

        if (tracks.position.length > 0) {
            const s = findSurroundingKeyframes(tracks.position, time);
            obj.position.set(
                lerp(s.a.value[0], s.b.value[0], s.t),
                lerp(s.a.value[1], s.b.value[1], s.t),
                lerp(s.a.value[2], s.b.value[2], s.t)
            );
        }
        if (tracks.rotation.length > 0) {
            const s = findSurroundingKeyframes(tracks.rotation, time);
            const qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                THREE.MathUtils.degToRad(s.a.value[0]), THREE.MathUtils.degToRad(s.a.value[1]), THREE.MathUtils.degToRad(s.a.value[2])
            ));
            const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                THREE.MathUtils.degToRad(s.b.value[0]), THREE.MathUtils.degToRad(s.b.value[1]), THREE.MathUtils.degToRad(s.b.value[2])
            ));
            qa.slerp(qb, s.t);
            obj.quaternion.copy(qa);
        }
        if (tracks.scale.length > 0) {
            const s = findSurroundingKeyframes(tracks.scale, time);
            obj.scale.set(
                lerp(s.a.value[0], s.b.value[0], s.t),
                lerp(s.a.value[1], s.b.value[1], s.t),
                lerp(s.a.value[2], s.b.value[2], s.t)
            );
        }
        if (tracks.color.length > 0 && obj.material && obj.material.color) {
            const s = findSurroundingKeyframes(tracks.color, time);
            obj.material.color.set(s.t === 0 ? s.a.value : lerpColor(s.a.value, s.b.value, s.t));
        }
        if (tracks.opacity.length > 0 && obj.material) {
            const s = findSurroundingKeyframes(tracks.opacity, time);
            const value = lerp(s.a.value, s.b.value, s.t);
            obj.material.opacity = value;
            obj.material.transparent = value < 1;
        }
        if (tracks.visible.length > 0) {
            // مسار خطوة (step) بلا تقريب: آخر إطار مفتاحي وصلنا زمنه فعلاً
            let value = tracks.visible[0].value;
            for (const k of tracks.visible) {
                if (k.t <= time) value = k.value; else break;
            }
            obj.visible = value;
        }
    }
}

// ============================================================
//  سجلّ عام لكل مُشغِّلات الحركة النشطة في المشهد — يُستدعى update() على
//  الكل مرة واحدة كل إطار من حلقة الرسم الرئيسية (Html3D.js أو main.js)
// ============================================================
export class AnimationRegistry {
    constructor() {
        this.players = new Set();
    }
    register(player) { this.players.add(player); }
    unregister(player) { this.players.delete(player); }
    update(delta) {
        this.players.forEach(p => p.update(delta));
    }
}

// نسخة مشتركة واحدة تُستخدم في كل المشروع (المحرر ومكتبة التشغيل معاً)
export const globalAnimationRegistry = new AnimationRegistry();

/**
 * يبني object.animations = { clipName: AnimationPlayer } من قائمة clips
 * مخزَّنة على الكائن (object.userData.animationClips)، ويُسجّلها في السجلّ
 * العام حتى تُحدَّث تلقائياً كل إطار. يُستدعى هذا عند: (أ) تحميل ملف SCAD
 * فيه Animations()، أو (ب) إنشاء/تعديل حركة داخل المحرر.
 */
export function buildAnimationsForObject(object) {
    const clipsData = object.userData.animationClips || {};
    object.animations = object.animations || {};

    // نزيل أي مُشغِّلات قديمة من السجلّ قبل إعادة البناء (تفادي تكرار)
    Object.values(object.animations).forEach(player => globalAnimationRegistry.unregister(player));
    object.animations = {};

    Object.keys(clipsData).forEach(name => {
        const clip = clipsData[name] instanceof AnimationClip ? clipsData[name] : AnimationClip.fromJSON(clipsData[name]);
        const player = new AnimationPlayer(object, clip);
        object.animations[name] = player;
        globalAnimationRegistry.register(player);
    });

    return object.animations;
}
