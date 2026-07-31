// ============================================================
//  Html3D.js - مكتبة HTML ثلاثية الأبعاد
//  الإصدار: 1.0
//  الترخيص: مفتوح المصدر
//  الوصف: تحويل عناصر HTML إلى مشاهد Three.js
// ============================================================

// ✅ هذا الملف أصبح يُستورد كـ ES module من main.js (لأن ScadParser
// أصبح مدموجاً هنا نهائياً). لذلك نستورد THREE بشكل حقيقي بدل الاعتماد
// على وجود window.THREE عالمياً (والذي لم يعد main.js يوفّره).
import * as THREE from 'three';

// ============================================================
//  Optional dependencies — defensive loading
// ------------------------------------------------------------
//  Some host projects (games/viewers built with this library that
//  are NOT the editor) may not link every optional module below —
//  e.g. no CSG/bevel tooling, no animation/effects authoring system,
//  or no "three/addons" importmap entry for CSS2DRenderer. In all
//  of these cases the library must keep working correctly; it just
//  skips the corresponding feature and logs a single clear English
//  warning the first time that feature is actually needed, instead
//  of crashing the whole module at import time or spamming the
//  console every frame.
// ============================================================

const _warnedFeatures = new Set();
function warnFeatureOnce(feature, message) {
    if (_warnedFeatures.has(feature)) return;
    _warnedFeatures.add(feature);
    console.warn(`Html3D: ${message}`);
}

let CSS2DRenderer = null, CSS2DObject = null;
try {
    ({ CSS2DRenderer, CSS2DObject } = await import('three/addons/renderers/CSS2DRenderer.js'));
} catch (e) {
    console.warn('Html3D: "three/addons/renderers/CSS2DRenderer.js" not available — <label>/<button> elements will be skipped. Add an importmap entry for "three/addons/" to enable HTML labels.');
}

// ✅ عمليات Boolean حقيقية (union/difference/intersection) وتنعيم
// الرؤوس/الحواف (bevel) — مشتركة مع main.js حتى يتصرف المحرر التفاعلي
// ومحلّل SCAD بنفس المنطق تماماً. غير مطلوبة لمشاريع لا تحتاج تحريراً تفاعلياً.
let csgBoolean = null;
try {
    ({ csgBoolean } = await import('../js/csg-ops.js'));
} catch (e) {
    console.warn('Html3D: "js/csg-ops.js" (three-bvh-csg) not available — union()/difference()/intersection() will fall back to simple grouping instead of real boolean operations.');
}

let bevelVertexTopology = null, bevelEdgeTopology = null;
try {
    ({ bevelVertexTopology, bevelEdgeTopology } = await import('../js/bevel-ops.js'));
} catch (e) {
    console.warn('Html3D: "js/bevel-ops.js" not available — bevel_vertices()/bevel_edges() directives will be ignored (geometry left unmodified).');
}

// ✅ نظام الحركة (Animation) ونظام التأثيرات (Effects) — مشتركة مع المحرر
// (main.js) حتى يعمل التأليف والمعاينة والتصدير/الاستيراد بنفس المنطق تماماً.
// غير مطلوبة لمشاريع لا تحتوي حركات/تأثيرات مؤلَّفة بالمحرر.
let globalAnimationRegistry = null, buildAnimationsForObject = null;
try {
    ({ globalAnimationRegistry, buildAnimationsForObject } = await import('../js/animation-system.js'));
} catch (e) {
    console.warn('Html3D: "js/animation-system.js" not available — Animations() directive and animation clips will be ignored.');
}

let globalEffectRegistry = null, buildEffectsForObject = null;
try {
    ({ globalEffectRegistry, buildEffectsForObject } = await import('../js/effects-system.js'));
} catch (e) {
    console.warn('Html3D: "js/effects-system.js" not available — Effects() directive and particle/shader effects will be ignored.');
}

// ✅ مولّد الـ textures الإجرائية (Canvas 2D) — مشترك مع المحرر حتى ينتج
// نفس الصورة تماماً من نفس الاسم/الخيارات عند تنفيذ توجيه texture() في SCAD.
let generateProceduralTexture = null;
try {
    ({ generateProceduralTexture } = await import('../js/texture-ops.js'));
} catch (e) {
    console.warn('Html3D: "js/texture-ops.js" not available — texture() directive in SCAD will be ignored.');
}

(function(global) {
    'use strict';

    // ============================================================
    //  Scene-graph cleanup: collapse anonymous transform-only wrappers
    // ------------------------------------------------------------
    //  Every bare `translate([...])`, `rotate([...])`, and `scale([...])`
    //  in a SCAD file wraps whatever follows it in its own THREE.Group
    //  (this is required because each can appear alone, without braces,
    //  applying only to the single next statement). When a part is
    //  exported as a chain like:
    //      translate([...]) rotate([...]) scale([...]) cube([...]);
    //  that produces 3 nested, unnamed, single-child Groups around one
    //  Mesh — correct visually, but needlessly deep for one shape.
    //  This pass merges any such anonymous, marker-free, single-child
    //  Group into its child by baking the wrapper's transform onto the
    //  child, so one part ends up as (at most) one Group/Mesh instead
    //  of a long throwaway chain. Named groups, DOM-linked containers,
    //  labels, and anything else with meaningful state are left alone.
    // ============================================================
    function isPureTransformWrapper(obj) {
        return !!obj && obj.isGroup === true && obj.type === 'Group' &&
            (!obj.name || obj.name === '') &&
            !(obj.userData && (
                obj.userData.domElement ||
                obj.userData.sourceElement ||
                obj.userData.isLabel ||
                obj.userData.animationClips ||
                obj.userData.effectsData
            ));
    }

    function flattenTransformWrapperGroups(node) {
        if (!node || !node.children || node.children.length === 0) return;
        const originalChildren = node.children.slice();
        for (const originalChild of originalChildren) {
            let current = originalChild;
            while (isPureTransformWrapper(current) && current.children.length === 1) {
                const next = current.children[0];
                current.updateMatrix();
                next.updateMatrix();
                const combined = new THREE.Matrix4().multiplyMatrices(current.matrix, next.matrix);
                const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
                combined.decompose(pos, quat, scl);
                next.position.copy(pos);
                next.quaternion.copy(quat);
                next.scale.copy(scl);
                current = next;
            }
            if (current !== originalChild) {
                node.remove(originalChild);
                node.add(current);
            }
            flattenTransformWrapperGroups(current);
        }
    }


    // ============================================================
    //  2. Engine.js (منقول بالكامل)
    // ============================================================
    class Engine {
        constructor() {
            this.version = '1.0';
            this.scene = null;
            this.camera = null;
            this.renderer = null;
        }

        initScene(container, options = {}) {
    const { backgroundColor = 0x111122, fov = 45, near = 0.1, far = 1000 } = options;
    
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(backgroundColor);
    
    // ✅ تأكد من أن المشهد يحتوي على إضاءة افتراضية
    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambient);
    
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(5, 10, 5);
    this.scene.add(dirLight);
    
    // ✅ الكاميرا
    this.camera = new THREE.PerspectiveCamera(fov, container.clientWidth / container.clientHeight, near, far);
    this.camera.position.set(5, 5, 5);
    this.camera.lookAt(0, 0, 0);
    
    // ✅ الريندرر
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);
    
    // ✅ إضافة الشبكة والمحاور (مع التأكد من أنهما مرئيان)
    this.addHelperGrid();
    this.addAxesHelper();
    
    // ✅ إضافة إضاءة إضافية (للخلفية)
    const backLight = new THREE.DirectionalLight(0x4488ff, 0.5);
    backLight.position.set(-5, 0, -5);
    this.scene.add(backLight);
    
    return { scene: this.scene, camera: this.camera, renderer: this.renderer };
}
        
        addHelperGrid(size = 20, divisions = 20) {
            const gridHelper = new THREE.GridHelper(size, divisions, 0x888888, 0x444444);
            this.scene.add(gridHelper);
            return gridHelper;
        }
        
        addAxesHelper(size = 5) {
            const axesHelper = new THREE.AxesHelper(size);
            this.scene.add(axesHelper);
            return axesHelper;
        }
        
        build(modelData) {
            if (!modelData.version) modelData.version = '1.0';
            const rootGroup = new THREE.Group();
            rootGroup.userData = { metadata: modelData.metadata, originalData: modelData };
            const materials = this.buildMaterials(modelData.materials || []);
            
            if (modelData.hierarchy && modelData.hierarchy.length) {
                this.buildHierarchy(rootGroup, modelData.hierarchy, materials, modelData);
            } else {
                const mesh = this.buildMeshFromData(modelData, materials);
                rootGroup.add(mesh);
            }
            return rootGroup;
        }
        
        buildMaterials(materialsData) {
            const materials = [];
            for (const mat of materialsData) {
                let material;
                if (mat.type === 'MeshStandardMaterial') {
                    material = new THREE.MeshStandardMaterial({
                        color: mat.color || 0xffffff,
                        roughness: mat.roughness || 0.5,
                        metalness: mat.metalness || 0,
                        transparent: mat.transparent || false,
                        opacity: mat.opacity || 1,
                        emissive: mat.emissive || 0x000000
                    });
                } else if (mat.type === 'MeshBasicMaterial') {
                    material = new THREE.MeshBasicMaterial({ color: mat.color || 0xffffff });
                } else {
                    material = new THREE.MeshStandardMaterial({ color: 0xcccccc });
                }
                material.userData = mat.userData || {};
                materials.push(material);
            }
            return materials;
        }
        
        buildMeshFromData(data, materials) {
            const geometry = new THREE.BufferGeometry();
            const vertices = new Float32Array(data.vertices);
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            
            if (data.faces) {
                const indices = [];
                for (const face of data.faces) {
                    indices.push(face[0], face[1], face[2]);
                }
                geometry.setIndex(indices);
            }
            
            if (data.normals) {
                geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(data.normals), 3));
            } else {
                geometry.computeVertexNormals();
            }
            
            if (data.uvs) {
                geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uvs), 2));
            }
            
            const material = materials[0] || new THREE.MeshStandardMaterial({ color: 0x88aaff });
            const mesh = new THREE.Mesh(geometry, material);
            
            if (data.transforms) {
                mesh.position.set(data.transforms.position?.x || 0, data.transforms.position?.y || 0, data.transforms.position?.z || 0);
                mesh.rotation.set(data.transforms.rotation?.x || 0, data.transforms.rotation?.y || 0, data.transforms.rotation?.z || 0);
                mesh.scale.set(data.transforms.scale?.x || 1, data.transforms.scale?.y || 1, data.transforms.scale?.z || 1);
            }
            
            mesh.userData = { name: data.metadata?.name || 'unnamed' };
            return mesh;
        }
        
        buildHierarchy(parent, hierarchy, materials, modelData) {
            for (const node of hierarchy) {
                let obj;
                if (node.type === 'group') {
                    obj = new THREE.Group();
                    if (node.children) {
                        this.buildHierarchy(obj, node.children, materials, modelData);
                    }
                } else if (node.type === 'mesh') {
                    const meshData = modelData.meshes?.find(m => m.id === node.meshId) || node.data;
                    if (meshData) {
                        obj = this.buildMeshFromData(meshData, materials);
                    } else {
                        obj = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), materials[0]);
                    }
                }
                if (obj) {
                    obj.name = node.name || 'node';
                    if (node.transforms) {
                        obj.position.set(node.transforms.position?.x || 0, node.transforms.position?.y || 0, node.transforms.position?.z || 0);
                        obj.rotation.set(node.transforms.rotation?.x || 0, node.transforms.rotation?.y || 0, node.transforms.rotation?.z || 0);
                        obj.scale.set(node.transforms.scale?.x || 1, node.transforms.scale?.y || 1, node.transforms.scale?.z || 1);
                    }
                    parent.add(obj);
                }
            }
        }
        
        exportToAsset(root) {
            const asset = {
                version: this.version,
                metadata: root.userData?.metadata || { name: root.name || 'ExportedModel', created: new Date().toISOString() },
                vertices: [],
                faces: [],
                normals: [],
                uvs: [],
                materials: [],
                hierarchy: [],
                transforms: {}
            };
            
            root.traverse(child => {
                if (child.isMesh) {
                    const positions = child.geometry.attributes.position.array;
                    const indices = child.geometry.index ? child.geometry.index.array : [];
                    asset.vertices = Array.from(positions);
                    for (let i = 0; i < indices.length; i += 3) {
                        asset.faces.push([indices[i], indices[i+1], indices[i+2]]);
                    }
                    if (child.geometry.attributes.normal) asset.normals = Array.from(child.geometry.attributes.normal.array);
                    const mat = child.material;
                    asset.materials.push({
                        type: mat.type,
                        color: mat.color.getHex(),
                        roughness: mat.roughness,
                        metalness: mat.metalness,
                        transparent: mat.transparent,
                        opacity: mat.opacity
                    });
                    asset.hierarchy.push({
                        name: child.name,
                        type: 'mesh',
                        transforms: {
                            position: { x: child.position.x, y: child.position.y, z: child.position.z },
                            rotation: { x: child.rotation.x, y: child.rotation.y, z: child.rotation.z },
                            scale: { x: child.scale.x, y: child.scale.y, z: child.scale.z }
                        }
                    });
                }
            });
            return asset;
        }
        
        importAsset(jsonData) {
            return this.build(jsonData);
        }
    }

    // ============================================================
    //  3. ScadParser.js (منقول بالكامل)
    // ============================================================
  class ScadParser {
    constructor() {
        this.modules = new Map();
        this.resultGroup = null;
        this.currentGroup = null;
        this.variables = {};
      this._lastCubeMesh = null;      // آخر مكعب تم إنشاؤه (لتطبيق vertex_offsets التي تليه)
      this._lastCubeSize = null;
    this._currentColor = null;      // ← 
    }

    parse(scadCode) {
        let cleaned = scadCode.replace(/\/\/.*$/gm, '');
        cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

        this.modules.clear();
        this.resultGroup = new THREE.Group();
        this.currentGroup = this.resultGroup;
        this.variables = {};
        this._lastMesh = null;
        // ✅ سجلّ اسم -> كائن، يُملأ عبر أمر name(...) بعد كل شكل، ويُستخدم
        // بواسطة كتلتَي Animations()/Effects() في نهاية الملف للإشارة لأي
        // كائن باسمه
        this._namedObjects = {};

        const tokens = this.tokenize(cleaned);
        this.evaluateInstructions(tokens);

        // ✅ نبني object.animations{} و object.effects{} لكل كائن مسمّى
        // يملك بيانات محفوظة، مباشرة بعد التحليل — حتى تعمل
        // mesh.animations.rolling.play() فور تحميل الملف دون أي خطوة إضافية
        Object.values(this._namedObjects).forEach(obj => {
            if (obj.userData.animationClips) {
                if (buildAnimationsForObject) {
                    buildAnimationsForObject(obj);
                } else {
                    warnFeatureOnce('animation-system', 'animation-system.js unavailable — Animations() data present but ignored.');
                }
            }
            if (obj.userData.effectsData) {
                if (buildEffectsForObject) {
                    buildEffectsForObject(obj, this.resultGroup);
                } else {
                    warnFeatureOnce('effects-system', 'effects-system.js unavailable — Effects() data present but ignored.');
                }
            }
        });

        // ✅ تبسيط الشجرة: دمج سلاسل الـ Group الفارغة (translate/rotate/scale
        // المتتالية بلا اسم) الناتجة عن أوامر التحويل غير المُقوَّسة، بدل
        // ترك سلسلة طويلة من Groups الفارغة لكل جزء واحد فقط
        flattenTransformWrapperGroups(this.resultGroup);

        return this.resultGroup;
    }

    tokenize(code) {
        const tokens = [];
        const regex = /([a-zA-Z_][a-zA-Z0-9_]*)|(-?[0-9]*\.?[0-9]+)|([\{\}\(\)\[\],])|([=])|(["'][^"']*["'])/g;
        let match;
        while ((match = regex.exec(code)) !== null) {
            tokens.push(match[0]);
        }
        return tokens;
    }

    evaluateInstructions(tokens) {
        // نستخدم "cursor" (كائن يُمرَّر بالمرجع) بدل رقم idx عادي،
        // لأن الأرقام في JS تُمرَّر بالقيمة: لو مرّرنا idx كرقم عادي لأي دالة
        // فإن أي تقدّم يحصل داخلها لن ينعكس هنا، وهذا بالضبط سبب مشكلة
        // عدم تطبيق translate سابقاً (موضع القراءة كان "يفقد التزامن").
        const cursor = { i: 0 };
        const peek = () => tokens[cursor.i];
        const consume = () => tokens[cursor.i++];

        const parseBlock = (stopOnBrace = true) => {
            while (cursor.i < tokens.length && (stopOnBrace ? tokens[cursor.i] !== '}' : true)) {
                const token = peek();

                if (token === 'module') {
                    cursor.i++;
                    const name = peek();
                    cursor.i++;
                    if (peek() === '(') {
                        while (peek() !== ')') cursor.i++;
                        cursor.i++;
                    }
                    if (peek() === '{') {
                        cursor.i++;
                        const bodyTokens = [];
                        let braceCount = 1;
                        while (cursor.i < tokens.length && braceCount > 0) {
                            const t = peek();
                            if (t === '{') braceCount++;
                            if (t === '}') braceCount--;
                            if (braceCount > 0) bodyTokens.push(t);
                            cursor.i++;
                        }
                        this.modules.set(name, bodyTokens.slice());
                    }
                } else if (token === '}') {
                    cursor.i++;
                    break;
                } else if (token === '=') {
                    cursor.i++;
                } else if (token === ';') {
                    cursor.i++;
                } else {
                    const cmdStartIndex = cursor.i;
                    const cmd = consume();
                    // ✅ تتبّع عام لآخر كائن أُضيف لأي مجموعة حالية بعد كل جملة —
                    // يُستخدم بواسطة أمر name(...) لتسمية أي شكل (وليس المكعب
                    // فقط) حتى تستطيع كتلة Animations()/Effects() لاحقاً
                    // بالملف الإشارة إليه بالاسم
                    const childCountBefore = this.currentGroup.children.length;
                    try {
                        this.executeCommand(cmd, tokens, cursor, parseBlock);
                    } catch (err) {
                        // ✅ شبكة أمان حرجة: خطأ في جملة واحدة (لأي سبب) لم يعد
                        // يُسقط كل الأجسام التي نجح تحليلها قبلها في نفس الملف.
                        // سابقاً كان أي خطأ متأخر بالملف (حتى قرب النهاية) يجعل
                        // parse() بالكامل يرمي استثناءً، وبما أن main.js لا
                        // يضيف شيئاً للمشهد إلا بعد نجاح parse() بالكامل، كان
                        // هذا يعني اختفاء كل شيء (لا أجسام، لا إضاءات، لا شيء)
                        // رغم نجاح تحليل معظم الملف فعلياً.
                        console.error(`SCAD parse error in statement "${cmd}" — skipping it and continuing:`, err);
                        if (cursor.i <= cmdStartIndex) cursor.i = cmdStartIndex + 1;
                    }
                    if (this.currentGroup.children.length > childCountBefore) {
                        this._lastMesh = this.currentGroup.children[this.currentGroup.children.length - 1];
                    }
                }
            }
        };

        parseBlock(false);
    }

    executeCommand(cmd, tokens, cursor, parseBlock) {
        if (cmd === 'cube') {
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let params = '';
                let parenCount = 1;
                while (cursor.i < tokens.length && parenCount > 0) {
                    const t = tokens[cursor.i];
                    if (t === '(') parenCount++;
                    if (t === ')') parenCount--;
                    if (parenCount > 0) params += t;
                    cursor.i++;
                }
                const size = this.parseVectorParam(params, 'size', [1, 1, 1]);
                const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
                const material = new THREE.MeshStandardMaterial({ color: 0x88aaff, roughness: 0.3 });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.userData.shapeType = 'cube';
                mesh.userData._originalParams = { width: size[0], height: size[1], depth: size[2] };
                mesh.userData.vertexOffsets = {};
                mesh.userData._verticesModified = false;
                this.currentGroup.add(mesh);

                // نتذكر آخر مكعب أُنشئ حتى نطبّق عليه vertex_offsets
                // إن ظهرت بعده مباشرة في الكود (وهي الصيغة التي يصدّرها المحرر)
                this._lastCubeMesh = mesh;
                this._lastCubeSize = size;

                if (tokens[cursor.i] === ';') cursor.i++;
            }
        } else if (cmd === 'sphere') {
            this._lastCubeMesh = null;
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let params = '';
                let parenCount = 1;
                while (cursor.i < tokens.length && parenCount > 0) {
                    const t = tokens[cursor.i];
                    if (t === '(') parenCount++;
                    if (t === ')') parenCount--;
                    if (parenCount > 0) params += t;
                    cursor.i++;
                }
                const r = this.parseNumberParam(params, 'r', 1);
                const geometry = new THREE.SphereGeometry(r, 32, 32);
                const material = new THREE.MeshStandardMaterial({ color: 0xffaa88, roughness: 0.2 });
                const mesh = new THREE.Mesh(geometry, material);
                this.currentGroup.add(mesh);
                if (tokens[cursor.i] === ';') cursor.i++;
            }
        } else if (cmd === 'cylinder') {
            this._lastCubeMesh = null;
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let params = '';
                let parenCount = 1;
                while (cursor.i < tokens.length && parenCount > 0) {
                    const t = tokens[cursor.i];
                    if (t === '(') parenCount++;
                    if (t === ')') parenCount--;
                    if (parenCount > 0) params += t;
                    cursor.i++;
                }
                const r = this.parseNumberParam(params, 'r', 1);
                const h = this.parseNumberParam(params, 'h', 2);
                const geometry = new THREE.CylinderGeometry(r, r, h, 32);
                const material = new THREE.MeshStandardMaterial({ color: 0x88ffaa, roughness: 0.3 });
                const mesh = new THREE.Mesh(geometry, material);
                this.currentGroup.add(mesh);
                if (tokens[cursor.i] === ';') cursor.i++;
            }
        } else if (cmd === 'translate' || cmd === 'rotate' || cmd === 'scale') {
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let vecStr = '';
                let parenCount = 1;
                while (cursor.i < tokens.length && parenCount > 0) {
                    const t = tokens[cursor.i];
                    if (t === '(') parenCount++;
                    if (t === ')') parenCount--;
                    if (parenCount > 0) vecStr += t;
                    cursor.i++;
                }
                const vector = this.parseVector(vecStr);
                const oldGroup = this.currentGroup;
                const transformGroup = new THREE.Group();

                if (cmd === 'translate') {
                    transformGroup.position.set(vector[0] || 0, vector[1] || 0, vector[2] || 0);
                } else if (cmd === 'rotate') {
                    transformGroup.rotation.set(
                        THREE.MathUtils.degToRad(vector[0] || 0),
                        THREE.MathUtils.degToRad(vector[1] || 0),
                        THREE.MathUtils.degToRad(vector[2] || 0)
                    );
                } else if (cmd === 'scale') {
                    transformGroup.scale.set(vector[0] || 1, vector[1] || 1, vector[2] || 1);
                }

                oldGroup.add(transformGroup);
                this.currentGroup = transformGroup;

                if (tokens[cursor.i] === '{') {
                    // شكل بأقواس: translate([...]) { ... }
                    cursor.i++;
                    parseBlock(true);
                    if (tokens[cursor.i] === '}') cursor.i++;
                } else {
                    // شكل بدون أقواس (الأكثر شيوعاً عند التصدير): translate([...]) cube([...]);
                    // ينطبق التحويل على العبارة التالية فقط
                    if (tokens[cursor.i] !== undefined && tokens[cursor.i] !== ';') {
                        const nextCmd = tokens[cursor.i];
                        cursor.i++;
                        this.executeCommand(nextCmd, tokens, cursor, parseBlock);
                    }
                    if (tokens[cursor.i] === ';') cursor.i++;
                }

                this.currentGroup = oldGroup;
            }
        } else if (cmd === 'union' || cmd === 'difference' || cmd === 'intersection') {
            // ✅ عملية CSG حقيقية الآن (بدل التجميع Group البسيط سابقاً):
            // نحدّد الأشكال (meshes) الموجودة داخل الكتلة {...} بترتيب ظهورها،
            // وننفّذ الدمج المنطقي الفعلي بينها بواسطة three-bvh-csg.
            // difference: الأول ناقص كل ما بعده (تماماً كسلوك OpenSCAD).
            // union/intersection: بالتتابع من اليسار لليمين.
            if (tokens[cursor.i] === '(') {
                while (cursor.i < tokens.length && tokens[cursor.i] !== ')') cursor.i++;
                cursor.i++;
            }
            if (tokens[cursor.i] === '{') {
                cursor.i++;
                const oldGroup = this.currentGroup;
                const tempGroup = new THREE.Group();
                this.currentGroup = tempGroup;
                parseBlock(true);
                if (tokens[cursor.i] === '}') cursor.i++;
                this.currentGroup = oldGroup;

                tempGroup.updateMatrixWorld(true);

                // كل الأشكال (Mesh) الموجودة داخل الكتلة، بترتيب ظهورها في الشجرة
                const meshes = [];
                tempGroup.traverse(node => { if (node.isMesh) meshes.push(node); });

                if (meshes.length === 0) {
                    tempGroup.children.forEach(child => this.currentGroup.add(child));
                } else if (meshes.length === 1) {
                    tempGroup.children.forEach(child => this.currentGroup.add(child));
                } else if (!csgBoolean) {
                    warnFeatureOnce('csg', 'CSG boolean ops (union/difference/intersection) unavailable — grouping shapes instead of performing a real boolean operation.');
                    tempGroup.children.forEach(child => this.currentGroup.add(child));
                } else {
                    try {
                        let result = meshes[0];
                        for (let i = 1; i < meshes.length; i++) {
                            result = csgBoolean(result, meshes[i], cmd);
                        }
                        this.currentGroup.add(result);
                        // أي عناصر أخرى غير Mesh داخل الكتلة (نادر) تُنقَل كما هي
                        tempGroup.children.forEach(child => {
                            if (!meshes.includes(child) && child.type !== 'Group') this.currentGroup.add(child);
                        });
                    } catch (e) {
                        console.error('CSG boolean failed, falling back to grouping:', e);
                        tempGroup.children.forEach(child => this.currentGroup.add(child));
                    }
                }
            }
        } else if (cmd === 'color') {
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let colorStr = '';
                let parenCount = 1;
                while (cursor.i < tokens.length && parenCount > 0) {
                    const t = tokens[cursor.i];
                    if (t === '(') parenCount++;
                    if (t === ')') parenCount--;
                    if (parenCount > 0) colorStr += t;
                    cursor.i++;
                }
                const colorHex = this.parseColor(colorStr);
                const oldGroup = this.currentGroup;
                const colorGroup = new THREE.Group();
                oldGroup.add(colorGroup);
                this.currentGroup = colorGroup;
                this._currentColor = colorHex;
                if (tokens[cursor.i] === '{') {
                    cursor.i++;
                    parseBlock(true);
                    if (tokens[cursor.i] === '}') cursor.i++;
                } else if (tokens[cursor.i] !== undefined && tokens[cursor.i] !== ';') {
                    const nextCmd = tokens[cursor.i];
                    cursor.i++;
                    this.executeCommand(nextCmd, tokens, cursor, parseBlock);
                    if (tokens[cursor.i] === ';') cursor.i++;
                }

                this.applyColorToGroup(colorGroup, colorHex);
                this.currentGroup = oldGroup;
            }
        } else if (cmd === 'vertex_offsets') {
            // قراءة الإزاحات: vertex_offsets = [ [idx, [dx,dy,dz]], ... ];
            let fullCode = '';
            let bracketCount = 0;
            while (cursor.i < tokens.length) {
                const t = tokens[cursor.i];
                if (t === '[') bracketCount++;
                if (t === ']') bracketCount--;
                fullCode += t + ' ';
                cursor.i++;
                if (bracketCount === 0 && tokens[cursor.i] === ';') {
                    cursor.i++;
                    break;
                }
            }

            const offsets = this.parseVertexOffsets(fullCode);
            if (offsets && this._lastCubeMesh) {
                const size = this._lastCubeSize || [1, 1, 1];
                const template = this.buildCubeTemplate(size);
                const result = this.applyOffsetsToTemplate(template, offsets);

                const oldGeometry = this._lastCubeMesh.geometry;
                const newGeometry = this.buildGeometryFromPoints(result.points, result.faces);
                this._lastCubeMesh.geometry = newGeometry;
                oldGeometry.dispose();

                this._lastCubeMesh.userData.shapeType = 'cube';
                this._lastCubeMesh.userData._originalParams = { width: size[0], height: size[1], depth: size[2] };
                this._lastCubeMesh.userData.vertexOffsets = offsets;
                this._lastCubeMesh.userData._verticesModified = true;
                // شبكة أمان: بعد إزاحة رأس بشكل كبير قد يصبح الشكل غير محدّب،
                // فنجعل المادة مرئية من الجهتين حتى لا تختفي أي أوجه.
                if (this._lastCubeMesh.material) {
                    this._lastCubeMesh.material.side = THREE.DoubleSide;
                }
            }
        } else if (cmd === 'Animations') {
            // ✅ كتلة مخصصة بنهاية الملف تحتوي كل حركات كل الكائنات المسمّاة:
            //   Animations( ObjectName( clipName(duration=.., loop=.., position=[[t,[x,y,z]],...], ...) ) )
            this.parseAnimationsBlock(tokens, cursor);
        } else if (cmd === 'Effects') {
            // ✅ نفس الفكرة لكن للتأثيرات:
            //   Effects( ObjectName( effectName(type="fire", intensity=1.2, ...) ) )
            this.parseEffectsBlock(tokens, cursor);
        } else if (cmd === 'texture') {
            // ✅ صيغة SCAD مخصصة (غير قياسية في OpenSCAD، تماماً كـ name()):
            //   texture(pattern="brick", color1="#8b5a2b", color2="#5c3a1e", cells=8);
            // تُطبَّق على آخر شكل تم إنشاؤه، وتبني الـ CanvasTexture فعلياً هنا
            // وقت الاستيراد باستخدام نفس المولّد المشترك مع المحرر
            // (../js/texture-ops.js) حتى تُنتج نفس الصورة تماماً.
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                const params = this.parseNamedParams(tokens, cursor);
                if (this._lastMesh && this._lastMesh.material && params.pattern) {
                    if (generateProceduralTexture) {
                        const tex = generateProceduralTexture(params.pattern, {
                            color1: params.color1,
                            color2: params.color2,
                            color3: params.color3,
                            cells: params.cells
                        });
                        this._lastMesh.material.map = tex;
                        this._lastMesh.material.needsUpdate = true;
                        // نحفظ نفس البيانات على userData حتى لو أُعيد تصدير هذا
                        // الشكل لاحقاً من المحرر بعد استيراده، يبقى round-trip كاملاً
                        this._lastMesh.userData.textureData = {
                            pattern: params.pattern,
                            color1: params.color1,
                            color2: params.color2,
                            cells: params.cells
                        };
                    } else {
                        warnFeatureOnce('texture-ops', 'texture-ops.js unavailable — texture() directive ignored, shape keeps its plain color only.');
                    }
                }
                if (tokens[cursor.i] === ';') cursor.i++;
            }
        } else if (cmd === 'name') {
            // ✅ name("ObjectLabel"); — يُسمّي آخر شكل تم إنشاؤه (أي نوع) بهذا
            // الاسم، ويسجّله في this._namedObjects حتى تستطيع Animations()/
            // Effects() لاحقاً في الملف الإشارة إليه
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let raw = tokens[cursor.i];
                cursor.i++;
                if (tokens[cursor.i] === ')') cursor.i++;
                const label = (raw || '').replace(/^["']|["']$/g, '');
                if (this._lastMesh && label) {
                    this._lastMesh.name = label;
                    this._namedObjects[label] = this._lastMesh;
                }
            }
        } else if (cmd === 'bevel_vertices' || cmd === 'bevel_edges') {
            // ✅ صيغة SCAD مخصصة (غير قياسية في OpenSCAD، تماماً كـ vertex_offsets)
            // لتنعيم/قطع زوايا رؤوس أو حواف بعد بنائها مباشرة:
            //   bevel_vertices = [ [idx, amount], [idx, amount], ... ];
            //   bevel_edges    = [ [[i, j], amount], [[i, j], amount], ... ];
            // تُطبَّق على آخر شكل تم إنشاؤه (this._lastCubeMesh) بغض النظر عن
            // كونه مكعباً بسيطاً أو شكلاً مخصصاً سبق تعديله بـ vertex_offsets.
            let fullCode = '';
            let bracketCount = 0;
            while (cursor.i < tokens.length) {
                const t = tokens[cursor.i];
                if (t === '[') bracketCount++;
                if (t === ']') bracketCount--;
                fullCode += t + ' ';
                cursor.i++;
                if (bracketCount === 0 && tokens[cursor.i] === ';') {
                    cursor.i++;
                    break;
                }
            }

            if (this._lastCubeMesh && this._lastCubeMesh.geometry && this._lastCubeMesh.geometry.attributes.position) {
                const entries = (cmd === 'bevel_vertices')
                    ? this.parseBevelVertices(fullCode)
                    : this.parseBevelEdges(fullCode);

                if (entries && entries.length > 0 && !bevelVertexTopology) {
                    warnFeatureOnce('bevel', 'bevel-ops.js unavailable — bevel_vertices()/bevel_edges() ignored, geometry left unmodified.');
                } else if (entries && entries.length > 0) {
                    let positions = Array.from(this._lastCubeMesh.geometry.attributes.position.array);
                    let indices;
                    if (this._lastCubeMesh.geometry.index) {
                        indices = Array.from(this._lastCubeMesh.geometry.index.array);
                    } else {
                        // هندسة بلا index attribute (نادر) — رتّب فهارس متتالية
                        const vertexCount = positions.length / 3;
                        indices = Array.from({ length: vertexCount }, (_, i) => i);
                    }

                    entries.forEach(entry => {
                        let result;
                        if (cmd === 'bevel_vertices') {
                            result = bevelVertexTopology(positions, indices, entry.index, entry.amount);
                        } else {
                            result = bevelEdgeTopology(positions, indices, entry.a, entry.b, entry.amount);
                        }
                        positions = result.positions;
                        indices = result.indices;
                    });

                    const oldGeometry = this._lastCubeMesh.geometry;
                    const newGeometry = new THREE.BufferGeometry();
                    newGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                    newGeometry.setIndex(indices);
                    newGeometry.computeVertexNormals();
                    this._lastCubeMesh.geometry = newGeometry;
                    oldGeometry.dispose();

                    // الطوبولوجيا تغيّرت فعلاً (رؤوس/أوجه جديدة) — لم يعد شكلاً
                    // بسيطاً قابلاً للتعبير كـ "مكعب + إزاحات"، فيُصدَّر لاحقاً
                    // كـ polyhedron كامل (نفس مسار الأشكال المخصصة الأخرى)
                    this._lastCubeMesh.userData.shapeType = 'custom';
                    this._lastCubeMesh.userData._verticesModified = true;
                    this._lastCubeMesh.userData[cmd] = entries;
                    if (this._lastCubeMesh.material) {
                        this._lastCubeMesh.material.side = THREE.DoubleSide;
                    }
                }
            }
        } else if (cmd === 'polyhedron') {
            // شكل عام (يُستخدم لأي شكل خضع لتعديل رؤوس/حواف/أوجه مخصص —
            // إضافة/حذف رأس، إضافة/حذف حافة، بثق/حذف وجه — ولم يعد قابلاً
            // للتعبير عنه كـ "مكعب + إزاحات" بسيطة): polyhedron(points=[...], faces=[...]);
            this._lastCubeMesh = null; // ليس مكعباً بسيطاً؛ لا تُطبَّق عليه vertex_offsets تالية
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                let points = [];
                let faces = [];
                let parenDepth = 1;

                while (cursor.i < tokens.length && parenDepth > 0) {
                    const t = tokens[cursor.i];
                    if (t === '(') { parenDepth++; cursor.i++; continue; }
                    if (t === ')') { parenDepth--; cursor.i++; continue; }

                    if (t === 'points') {
                        cursor.i++;
                        if (tokens[cursor.i] === '=') cursor.i++;
                        if (tokens[cursor.i] === '[') {
                            points = this.parseNestedArray(tokens, cursor);
                        }
                    } else if (t === 'faces') {
                        cursor.i++;
                        if (tokens[cursor.i] === '=') cursor.i++;
                        if (tokens[cursor.i] === '[') {
                            faces = this.parseNestedArray(tokens, cursor);
                        }
                    } else {
                        cursor.i++;
                    }
                }

                if (points.length > 0 && faces.length > 0) {
                    const geometry = this.buildGeometryFromPoints(points, faces);
                    const material = new THREE.MeshStandardMaterial({
                        color: 0x88aaff, roughness: 0.3, side: THREE.DoubleSide
                    });
                    const mesh = new THREE.Mesh(geometry, material);
                    mesh.userData.shapeType = 'custom';
                    mesh.userData._verticesModified = true;
                    this.currentGroup.add(mesh);
                    this._lastPolyhedronMesh = mesh; // يتيح لـ color(...) اللاحق تلوينه إن وُجد
                }

                if (tokens[cursor.i] === ';') cursor.i++;
            }
        } else if (cmd === 'light') {
            // ✅ صيغة SCAD مخصصة لتصدير/استيراد الإضاءات (غير قياسية في
            // OpenSCAD، تماماً كـ vertex_offsets): light(type="...", position=[...], ...);
            this._lastCubeMesh = null;
            if (tokens[cursor.i] === '(') {
                cursor.i++;
                const params = this.parseNamedParams(tokens, cursor);

                const lightType = params.type || 'point';
                const pos = params.position || [0, 3, 0];
                const color = params.color || [1, 1, 1];
                const colorHex = (Math.round(color[0] * 255) << 16) | (Math.round(color[1] * 255) << 8) | Math.round(color[2] * 255);
                const intensity = (params.intensity !== undefined) ? params.intensity : 1;

                let light = null;
                if (lightType === 'ambient') {
                    light = new THREE.AmbientLight(colorHex, intensity);
                } else if (lightType === 'directional') {
                    light = new THREE.DirectionalLight(colorHex, intensity);
                } else if (lightType === 'point') {
                    light = new THREE.PointLight(colorHex, intensity, params.distance || 0);
                } else if (lightType === 'spot') {
                    light = new THREE.SpotLight(colorHex, intensity, params.distance || 0,
                        params.angle !== undefined ? params.angle : Math.PI / 3, params.penumbra || 0);
                } else if (lightType === 'hemisphere') {
                    const groundColor = params.groundColor || [0.2, 0.2, 0.2];
                    const groundHex = (Math.round(groundColor[0] * 255) << 16) | (Math.round(groundColor[1] * 255) << 8) | Math.round(groundColor[2] * 255);
                    light = new THREE.HemisphereLight(colorHex, groundHex, intensity);
                }

                if (light) {
                    light.position.set(pos[0], pos[1], pos[2]);
                    if (params.name) light.name = params.name;
                    if (params.rotation && light.target) {
                        light.rotation.set(
                            THREE.MathUtils.degToRad(params.rotation[0] || 0),
                            THREE.MathUtils.degToRad(params.rotation[1] || 0),
                            THREE.MathUtils.degToRad(params.rotation[2] || 0)
                        );
                    }
                    this.currentGroup.add(light);
                }

                if (tokens[cursor.i] === ';') cursor.i++;
            }
        } else {
            if (this.modules.has(cmd)) {
                if (tokens[cursor.i] === '(') {
                    while (tokens[cursor.i] !== ')') cursor.i++;
                    cursor.i++;
                }
                if (tokens[cursor.i] === ';') cursor.i++;
                const bodyTokens = this.modules.get(cmd);
                const subParser = new ScadParser();
                subParser.modules = this.modules;
                subParser.resultGroup = new THREE.Group();
                subParser.currentGroup = subParser.resultGroup;
                subParser.evaluateInstructions(bodyTokens);
                subParser.resultGroup.children.forEach(child => {
                    this.currentGroup.add(child.clone());
                });
            }
        }
    }

    parseVectorParam(params, paramName, defaultValue) {
        const regex = new RegExp(`${paramName}\\s*=\\s*\\[([^\\]]+)\\]`);
        const match = params.match(regex);
        if (match) {
            return match[1].split(',').map(Number);
        }
        return defaultValue;
    }

    parseNumberParam(params, paramName, defaultValue) {
        const regex = new RegExp(`${paramName}\\s*=\\s*([0-9.]+)`);
        const match = params.match(regex);
        if (match) return parseFloat(match[1]);
        return defaultValue;
    }

    parseVector(vecStr) {
        const nums = vecStr.match(/[-+]?[0-9]*\.?[0-9]+/g);
        if (nums) return nums.map(Number);
        return [0, 0, 0];
    }

    parseColor(colorStr) {
        const str = colorStr.trim().replace(/['"]/g, '');
        const colors = {
            red: 0xff0000, green: 0x00ff00, blue: 0x0000ff,
            yellow: 0xffff00, white: 0xffffff, black: 0x000000,
            orange: 0xff8800, purple: 0x8800ff, pink: 0xff0088
        };
        if (colors[str]) return colors[str];
        if (str.startsWith('#')) return parseInt(str.slice(1), 16);
        // دعم صيغة color([r, g, b]) القياسية في OpenSCAD (قيم من 0 إلى 1)
        const nums = colorStr.match(/[-+]?[0-9]*\.?[0-9]+/g);
        if (nums && nums.length >= 3) {
            const clamp01 = v => Math.min(1, Math.max(0, parseFloat(v)));
            const r = Math.round(clamp01(nums[0]) * 255);
            const g = Math.round(clamp01(nums[1]) * 255);
            const b = Math.round(clamp01(nums[2]) * 255);
            return (r << 16) | (g << 8) | b;
        }
        return 0xcccccc;
    }

    applyColorToGroup(group, colorHex) {
        group.traverse(child => {
            if (child.isMesh) {
                const wasDoubleSided = child.material && child.material.side === THREE.DoubleSide;
                child.material = new THREE.MeshStandardMaterial({
                    color: colorHex,
                    roughness: 0.3,
                    metalness: 0.1,
                    // نحافظ على DoubleSide إن كانت موجودة أصلاً (شكل مخصص/معدَّل
                    // الرؤوس)، حتى لا يعيد التلوين إخفاء أي وجه بالخطأ
                    side: wasDoubleSided ? THREE.DoubleSide : THREE.FrontSide
                });
            }
        });
    }

    // ===== دعم نظام الإزاحات في ScadParser =====

// بناء قالب المكعب
buildCubeTemplate(size) {
    const s = {
        x: size[0] / 2,
        y: size[1] / 2,
        z: size[2] / 2
    };
    
    const points = [
        [-s.x, -s.y, -s.z],
        [ s.x, -s.y, -s.z],
        [ s.x, -s.y,  s.z],
        [-s.x, -s.y,  s.z],
        [-s.x,  s.y, -s.z],
        [ s.x,  s.y, -s.z],
        [ s.x,  s.y,  s.z],
        [-s.x,  s.y,  s.z]
    ];
    
    // ترتيب الرؤوس هنا مهم جداً (winding order): يجب أن يكون كل وجه
    // بترتيب يجعل المتجه العمودي (normal) يشير للخارج، وإلا فستُرى
    // الأوجه من جهة واحدة فقط بسبب أن المادة افتراضياً أحادية الجانب.
    const faces = [
        [0, 1, 2, 3], // bottom  (y-)
        [4, 7, 6, 5], // top     (y+)
        [0, 4, 5, 1], // front   (z-)
        [2, 6, 7, 3], // back    (z+)
        [1, 5, 6, 2], // right   (x+)
        [0, 3, 7, 4]  // left    (x-)
    ];
    
    return { points, faces };
}

// تطبيق الإزاحات على القالب
applyOffsetsToTemplate(template, offsets) {
    const points = template.points.map((p, idx) => {
        if (offsets[idx]) {
            return [p[0] + offsets[idx][0], p[1] + offsets[idx][1], p[2] + offsets[idx][2]];
        }
        return p;
    });
    return { points, faces: template.faces };
}

// بناء Mesh من النقاط والوجوه
buildMeshFromPoints(points, faces, color) {
    const geometry = this.buildGeometryFromPoints(points, faces);
    const material = new THREE.MeshStandardMaterial({
        color: color || 0x88aaff,
        flatShading: true,
        roughness: 0.5,
        metalness: 0.1
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData._verticesModified = true;
    mesh.userData.shapeType = 'cube';
    return mesh;
}

// بناء BufferGeometry فقط من النقاط والوجوه (تُستخدم لاستبدال geometry مكعب موجود)
buildGeometryFromPoints(points, faces) {
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    for (const p of points) {
        vertices.push(p[0], p[1], p[2]);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    const indices = [];
    for (const face of faces) {
        if (face.length === 3) {
            indices.push(face[0], face[1], face[2]);
        } else if (face.length > 3) {
            for (let i = 1; i < face.length - 1; i++) {
                indices.push(face[0], face[i], face[i + 1]);
            }
        }
    }
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

// ===== قراءة مصفوفة أرقام مسطحة مثل [1, 2, 3] (بعكس parseNestedArray
// التي تتوقع مصفوفة من مصفوفات) — تُستخدم لمعاملات مثل position/color =====
parseFlatArray(tokens, cursor) {
    cursor.i++; // تخطي '['
    const nums = [];
    while (cursor.i < tokens.length && tokens[cursor.i] !== ']') {
        if (tokens[cursor.i] !== ',') {
            const n = parseFloat(tokens[cursor.i]);
            if (!isNaN(n)) nums.push(n);
        }
        cursor.i++;
    }
    cursor.i++; // تخطي ']'
    return nums;
}

// ===== قراءة معاملات مسمّاة (key=value, key=value, ...) داخل أقواس أمر
// مثل light(type="directional", position=[...], intensity=1) =====
parseNamedParams(tokens, cursor) {
    const result = {};
    let parenDepth = 1;
    while (cursor.i < tokens.length && parenDepth > 0) {
        const t = tokens[cursor.i];
        if (t === '(') { parenDepth++; cursor.i++; continue; }
        if (t === ')') { parenDepth--; cursor.i++; continue; }
        if (t === ',') { cursor.i++; continue; }

        if (/^[a-zA-Z_]/.test(t)) {
            const key = t;
            cursor.i++;
            if (tokens[cursor.i] === '=') cursor.i++;
            if (tokens[cursor.i] === '[') {
                result[key] = this.parseFlatArray(tokens, cursor);
            } else if (tokens[cursor.i] !== undefined && tokens[cursor.i][0] === '"') {
                result[key] = tokens[cursor.i].replace(/['"]/g, '');
                cursor.i++;
            } else if (tokens[cursor.i] !== undefined) {
                const n = parseFloat(tokens[cursor.i]);
                result[key] = isNaN(n) ? tokens[cursor.i] : n;
                cursor.i++;
            }
        } else {
            cursor.i++;
        }
    }
    return result;
}

// ===== قراءة مصفوفة متداخلة من الأرقام مباشرة من تسلسل الرموز =====
// تُستخدم لقراءة points=[[x,y,z],...] و faces=[[i,j,k,...],...] في polyhedron.
// cursor.i يجب أن يشير إلى '[' الخارجي عند الاستدعاء؛ يتقدّم للموضع الذي
// يلي ']' المطابق مباشرة بعد الانتهاء.
parseNestedArray(tokens, cursor) {
    cursor.i++; // تخطي '[' الخارجي
    const result = [];
    while (cursor.i < tokens.length && tokens[cursor.i] !== ']') {
        if (tokens[cursor.i] === '[') {
            cursor.i++; // تخطي '[' الداخلي
            const nums = [];
            while (cursor.i < tokens.length && tokens[cursor.i] !== ']') {
                if (tokens[cursor.i] !== ',') {
                    const n = parseFloat(tokens[cursor.i]);
                    if (!isNaN(n)) nums.push(n);
                }
                cursor.i++;
            }
            cursor.i++; // تخطي ']' الداخلي
            result.push(nums);
        } else {
            cursor.i++; // فاصلة أو مسافة بين العناصر
        }
    }
    cursor.i++; // تخطي ']' الخارجي
    return result;
}

// ===== دالة لقراءة الإزاحات من الكود =====
parseVertexOffsets(code) {
    // ملاحظة: "code" هنا هو ما يلي كلمة vertex_offsets مباشرة (بدون الكلمة نفسها،
    // لأن المستدعي يكون قد استهلكها كأمر بالفعل) — لذا نبحث مباشرة عن
    // نمط [idx, [dx, dy, dz]] بغض النظر عن الأقواس المحيطة به.
    const pattern = /\[\s*(\d+)\s*,\s*\[\s*([^\]]+)\s*\]\s*\]/g;
    const offsets = {};
    let match;

    while ((match = pattern.exec(code)) !== null) {
        const idx = parseInt(match[1]);
        const coords = match[2].split(',').map(s => parseFloat(s.trim()));
        offsets[idx] = coords;
    }

    return Object.keys(offsets).length > 0 ? offsets : null;
}

// ===== دالة لقراءة bevel_vertices = [ [idx, amount], ... ]; =====
parseBevelVertices(code) {
    const pattern = /\[\s*(\d+)\s*,\s*([-+]?[0-9]*\.?[0-9]+)\s*\]/g;
    const result = [];
    let match;
    while ((match = pattern.exec(code)) !== null) {
        result.push({ index: parseInt(match[1]), amount: parseFloat(match[2]) });
    }
    return result;
}

// ===== دالة لقراءة bevel_edges = [ [[i, j], amount], ... ]; =====
parseBevelEdges(code) {
    const pattern = /\[\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*([-+]?[0-9]*\.?[0-9]+)\s*\]/g;
    const result = [];
    let match;
    while ((match = pattern.exec(code)) !== null) {
        result.push({ a: parseInt(match[1]), b: parseInt(match[2]), amount: parseFloat(match[3]) });
    }
    return result;
}

// ============================================================
//  قارئ قيم SCAD عام (يدعم: أرقام، true/false، نصوص بين علامتَي اقتباس،
//  ومصفوفات متداخلة [ ... ]) — يُستخدم لقراءة كتلتَي Animations()/Effects()
// ============================================================
readScadValue(tokens, cursor) {
    const t = tokens[cursor.i];
    if (t === '[') {
        cursor.i++;
        const arr = [];
        while (cursor.i < tokens.length && tokens[cursor.i] !== ']') {
            if (tokens[cursor.i] === ',') { cursor.i++; continue; }
            arr.push(this.readScadValue(tokens, cursor));
        }
        if (tokens[cursor.i] === ']') cursor.i++;
        return arr;
    }
    if (t === 'true') { cursor.i++; return true; }
    if (t === 'false') { cursor.i++; return false; }
    if (typeof t === 'string' && /^["'].*["']$/.test(t)) {
        cursor.i++;
        return t.replace(/^["']|["']$/g, '');
    }
    cursor.i++;
    return parseFloat(t);
}

// يقرأ محتوى كتلة حركة واحدة (بين قوسين) إلى بنية { name, duration, loop, tracks }
parseAnimationClipParams(tokens, cursor, clipName) {
    const clip = { name: clipName, duration: 1, loop: false, tracks: { position: [], rotation: [], scale: [], color: [], opacity: [], visible: [] } };
    const trackKeys = ['position', 'rotation', 'scale', 'color', 'opacity', 'visible'];
    while (cursor.i < tokens.length && tokens[cursor.i] !== ')') {
        if (tokens[cursor.i] === ',') { cursor.i++; continue; }
        const key = tokens[cursor.i];
        cursor.i++;
        if (tokens[cursor.i] === '=') cursor.i++;
        const value = this.readScadValue(tokens, cursor);
        if (key === 'duration') clip.duration = value;
        else if (key === 'loop') clip.loop = !!value;
        else if (trackKeys.includes(key) && Array.isArray(value)) {
            clip.tracks[key] = value.map(kf => ({ t: kf[0], value: kf[1] }));
        }
    }
    if (tokens[cursor.i] === ')') cursor.i++;
    return clip;
}

// يقرأ كتلة Animations( ObjectName( clip1(...) clip2(...) ) ObjectName2(...) )
// كاملة، ويُلحق النتيجة بـ object.userData.animationClips لكل كائن مذكور
parseAnimationsBlock(tokens, cursor) {
    if (tokens[cursor.i] !== '(') return;
    cursor.i++;
    while (cursor.i < tokens.length && tokens[cursor.i] !== ')') {
        if (tokens[cursor.i] === ',') { cursor.i++; continue; }
        // ✅ اسم الكائن قد يكون بين علامتَي اقتباس (يدعم مسافات/رموز خاصة
        // بالاسم) أو معرّفاً عادياً بدون اقتباس — ندعم الحالتين
        const objName = tokens[cursor.i].replace(/^["']|["']$/g, '');
        cursor.i++;
        if (tokens[cursor.i] !== '(') break;
        cursor.i++;
        const targetObject = this._namedObjects[objName];
        const clips = {};
        while (cursor.i < tokens.length && tokens[cursor.i] !== ')') {
            if (tokens[cursor.i] === ',') { cursor.i++; continue; }
            const clipName = tokens[cursor.i].replace(/^["']|["']$/g, '');
            cursor.i++;
            if (tokens[cursor.i] !== '(') break;
            cursor.i++;
            clips[clipName] = this.parseAnimationClipParams(tokens, cursor, clipName);
        }
        if (tokens[cursor.i] === ')') cursor.i++;
        if (targetObject) {
            targetObject.userData.animationClips = targetObject.userData.animationClips || {};
            Object.assign(targetObject.userData.animationClips, clips);
        } else {
            console.warn(`Animations(): لم يُعثر على كائن باسم "${objName}"`);
        }
    }
    if (tokens[cursor.i] === ')') cursor.i++;
}

// يقرأ كتلة Effects( ObjectName( effectName(type="fire", ...) ) ... ) كاملة
parseEffectsBlock(tokens, cursor) {
    if (tokens[cursor.i] !== '(') return;
    cursor.i++;
    while (cursor.i < tokens.length && tokens[cursor.i] !== ')') {
        if (tokens[cursor.i] === ',') { cursor.i++; continue; }
        const objName = tokens[cursor.i].replace(/^["']|["']$/g, '');
        cursor.i++;
        if (tokens[cursor.i] !== '(') break;
        cursor.i++;
        const targetObject = this._namedObjects[objName];
        const effectsData = {};
        while (cursor.i < tokens.length && tokens[cursor.i] !== ')') {
            if (tokens[cursor.i] === ',') { cursor.i++; continue; }
            const effectName = tokens[cursor.i].replace(/^["']|["']$/g, '');
            cursor.i++;
            if (tokens[cursor.i] !== '(') break;
            cursor.i++;
            const effectParams = {};
            while (cursor.i < tokens.length && tokens[cursor.i] !== ')') {
                if (tokens[cursor.i] === ',') { cursor.i++; continue; }
                const key = tokens[cursor.i];
                cursor.i++;
                if (tokens[cursor.i] === '=') cursor.i++;
                effectParams[key] = this.readScadValue(tokens, cursor);
            }
            if (tokens[cursor.i] === ')') cursor.i++;
            const type = effectParams.type;
            delete effectParams.type;
            effectsData[effectName] = { type, options: effectParams };
        }
        if (tokens[cursor.i] === ')') cursor.i++;
        if (targetObject) {
            targetObject.userData.effectsData = targetObject.userData.effectsData || {};
            Object.assign(targetObject.userData.effectsData, effectsData);
        } else {
            console.warn(`Effects(): لم يُعثر على كائن باسم "${objName}"`);
        }
    }
    if (tokens[cursor.i] === ')') cursor.i++;
}

// ===== دالة لقراءة الحجم من الكود =====
parseSize(code) {
    // البحث عن حجم المكعب: size = [1, 1, 1] أو cube_template(size)
    let sizeMatch = code.match(/size\s*=\s*\[\s*([^\]]+)\s*\]/);
    if (sizeMatch) {
        return sizeMatch[1].split(',').map(Number);
    }
    
    // البحث عن cube([1, 1, 1])
    sizeMatch = code.match(/cube\s*\(\s*\[\s*([^\]]+)\s*\]\s*\)/);
    if (sizeMatch) {
        return sizeMatch[1].split(',').map(Number);
    }
    
    // افتراضي
    return [1, 1, 1];
}
}


    // ============================================================
    //  4. DOM Parser (جديد) - يحلل عناصر HTML إلى كائنات Three.js
    // ============================================================
    class HtmlDomParser {
        constructor(engine, scadParser) {
            this.engine = engine;
            this.scadParser = scadParser;
            this.elementMap = new WeakMap(); // ربط عنصر DOM بكائن Three.js
            this.scene = null;
            this.worldElement = null;
        }

        parse(worldElement) {
            this.worldElement = worldElement;
            if (!this.scene) {
                console.error('HtmlDomParser: No scene set. Call setScene() first.');
                return null;
            }

            // إزالة الكائنات السابقة (مع الاحتفاظ بالشبكة والمحاور)
            const toRemove = [];
            this.scene.children.forEach(child => {
                if (!child.isGridHelper && !child.isAxesHelper) {
                    toRemove.push(child);
                }
            });
            toRemove.forEach(child => this.scene.remove(child));

            // تحليل أبناء <world>
            const children = worldElement.children;
            for (const child of children) {
                this.parseElement(child, this.scene);
            }

            return this.scene;
        }

        parseElement(element, parentGroup) {
    const tagName = element.tagName.toLowerCase();
    let threeObject = null;

    switch (tagName) {
        case 'mesh':
            threeObject = this.parseMesh(element);
            break;
        case 'cube':
            threeObject = this.parseCube(element);
            break;
        case 'sphere':
            threeObject = this.parseSphere(element);
            break;
        case 'cylinder':
            threeObject = this.parseCylinder(element);
            break;
        case 'cone':
            threeObject = this.parseCone(element);
            break;
        case 'torus':
            threeObject = this.parseTorus(element);
            break;
        case 'group':
            threeObject = this.parseGroup(element);
            break;
        case 'label':
             threeObject = this.parseLabel(element);
            break;
        case 'button':
    threeObject = this.parseButton(element);
    break;
        case 'plane':
    threeObject = this.parsePlane(element);
    break;
        case 'directional-light':
            threeObject = this.parseLight(element, 'directional');
            break;
        case 'point-light':
            threeObject = this.parseLight(element, 'point');
            break;
        case 'spot-light':
            threeObject = this.parseLight(element, 'spot');
            break;
        case 'ambient-light':
            threeObject = this.parseLight(element, 'ambient');
            break;
        case 'hemisphere-light':
            threeObject = this.parseLight(element, 'hemisphere');
            break;
        default:
            return;
    }

    if (threeObject) {
        // ✅ تطبيق الخصائص
        this.applyAttributes(element, threeObject);
        
        // داخل parseElement، بعد applyAttributes وقبل parentGroup.add

// ✅ قراءة خاصية anchor
const anchorAttr = element.getAttribute('anchor');
const isStatic = anchorAttr === null || anchorAttr === 'true' || anchorAttr === '';
threeObject.userData.anchor = isStatic;
        
        // ✅ إضافة إلى المجموعة الأب (مع التأكد من أنها THREE.Group أو THREE.Scene)
        if (parentGroup && parentGroup.add) {
            parentGroup.add(threeObject);
            // console.log(`✅ Added ${tagName} to scene`);
        } else {
            console.error(`❌ parentGroup is not valid for ${tagName}`);
        }

      // بعد parentGroup.add(threeObject)
if (threeObject.userData.isLabel && threeObject.userData.anchorToParent && parentGroup !== this.scene) {
    // ننقله من المشهد إلى الأب
    this.scene.remove(threeObject);
    parentGroup.add(threeObject);
    // نضبط موضعًا نسبيًا (0,0,0) أو من الإزاحة
    threeObject.position.set(0, 2, 0); // مثال: فوق الكائن
}
        
        // ✅ إضافة الفيزياء إذا كانت anchor=false والمدير موجود
// ✅ إضافة الفيزياء لجميع الأجسام (ثابتة أو ديناميكية)
if (Html3D.physicsManager && Html3D.physicsManager.enabled) {
    const shape = Html3D.physicsManager.detectShape(threeObject);
    // mass ستُحدد تلقائياً في addBody بناءً على anchor
    Html3D.physicsManager.addBody(threeObject, shape, {
        friction: 0.3,
        restitution: 0.3
    });
}
        
        // ✅ تخزين الربط
        this.elementMap.set(element, threeObject);
        threeObject.userData.domElement = element;

        // ✅ معالجة الأبناء
        for (const child of element.children) {
            this.parseElement(child, threeObject);
        }
    } else {
        console.warn(`⚠️ Failed to create ${tagName}`);
    }
}

        parseMesh(element) {
            const src = element.getAttribute('src');
            const id = element.getAttribute('id');
            if (!src) {
                console.warn('HtmlDomParser: <mesh> missing src attribute');
                return null;
            }

            // تحميل الملف (سنفترض أنه متاح محلياً)
            // في الإصدار الكامل، سنستخدم fetch أو XMLHttpRequest
            // هنا نستخدم طريقة بسيطة: نقرأ الملف كـ Text
            // لكن في الواقع يجب أن يكون تحميل غير متزامن
            // سنقوم بتنفيذ تحميل غير متزامن في دالة منفصلة
            
            // مؤقتاً: نستخدم نموذج افتراضي إذا لم نتمكن من التحميل
            try {
                // محاولة تحميل الملف (سيتم تنفيذها في async)
                // نعيد Group فارغ حالياً، وسيتم ملؤه لاحقاً
                const group = new THREE.Group();
                group.name = id ? id : 'mesh';
                return group;
            } catch (error) {
                console.error('Error loading mesh:', error);
                return null;
            }
        }

        // تحميل غير متزامن للملفات
        // ===== loadMeshAsync (النسخة المصححة) =====
async loadMeshAsync(element) {
    const src = element.getAttribute('src');
    // console.log('🔍 loadMeshAsync called for:', src); // ✅
    
    if (!src) {
        console.warn('⚠️ No src attribute');
        return null;
    }

    try {
        // console.log(`📡 Fetching: ${src}`);
        const response = await fetch(src);
        // console.log(`📡 Response status: ${response.status}`);
        
        if (!response.ok) {
            console.error(`❌ Failed: ${response.status}`);
            return null;
        }
        
        const content = await response.text();
        // console.log(`📄 Content length: ${content.length} bytes`);
        
        let group;
        const isSCAD = src.endsWith('.scad') || src.endsWith('.txt');
        const isJSON = src.endsWith('.json');
        
        if (isSCAD) {
            // console.log('🔧 Parsing SCAD...');
            group = this.scadParser.parse(content);
            // console.log(`✅ Group has ${group.children.length} children`);
        } else if (isJSON) {
            // console.log('🔧 Parsing JSON...');
            const data = JSON.parse(content);
            group = this.engine.build(data);
        } else {
            console.warn(`⚠️ Unsupported: ${src}`);
            return null;
        }
        
        // ✅ إيجاد الـ placeholder الذي أُضيف مسبقاً إلى المشهد أثناء parse() المتزامن
        // (parseMesh أنشأ Group فارغاً وأضافه فعلياً للمشهد؛ يجب دمج المحتوى الحقيقي فيه
        // بدلاً من ترك "group" الجديد معزولاً بلا أب — وهذا كان سبب عدم ظهور الأشكال المخصصة)
        const placeholder = this.elementMap.get(element);

        if (placeholder && placeholder.parent) {
            // نقل كل أبناء المجموعة المُحلَّلة حديثاً إلى الـ placeholder الموجود في المشهد
            while (group.children.length > 0) {
                placeholder.add(group.children[0]);
            }
            // تطبيق الخصائص (position/rotation/scale/color...) على الحاوية الفعلية في المشهد
            this.applyAttributes(element, placeholder);
            placeholder.userData.domElement = element;
            // elementMap يبقى يشير لنفس placeholder (لا حاجة لإعادة تعيينه)

            // معالجة الأبناء (عناصر HTML فرعية) ضمن الـ placeholder وليس ضمن group المعزول
            for (const child of element.children) {
                this.parseElement(child, placeholder);
            }

            // console.log(`✅ Loaded and attached: ${src} (${placeholder.children.length} children in scene)`);
            return placeholder;
        } else {
            // لا يوجد placeholder في المشهد (حالة نادرة) — كحل احتياطي، أضف group مباشرة
            // كطفل للمشهد الرئيسي حتى لا تُفقد الهندسة المُحمَّلة
            console.warn('⚠️ No placeholder found in scene for', src, '— attaching directly to scene as fallback');
            this.applyAttributes(element, group);
            this.elementMap.set(element, group);
            group.userData.domElement = element;
            if (this.scene) this.scene.add(group);
            for (const child of element.children) {
                this.parseElement(child, group);
            }
            return group;
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
        return null;
    }
}

        parseCube(element) {
    const size = this.parseVector3(element.getAttribute('size'), [1, 1, 1]);
    const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
    // ✅ استخدام MeshStandardMaterial مع لون افتراضي
    const material = new THREE.MeshStandardMaterial({ 
        color: 0x88aaff,
        roughness: 0.5,
        metalness: 0.1
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'cube';
    // ✅ دعم anchor من خلال userData
mesh.userData.anchor = true; // افتراضي ثابت
    return mesh;
}



// نفس التعديل لـ parseCylinder, parseCone, parseTorus

        parseSphere(element) {
            const radius = parseFloat(element.getAttribute('radius')) || 1;
            const geometry = new THREE.SphereGeometry(radius, 32, 32);
            const material = new THREE.MeshStandardMaterial({ color: 0xffaa88 });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'sphere';
            return mesh;
        }

        parseCylinder(element) {
            const radius = parseFloat(element.getAttribute('radius')) || 1;
            const height = parseFloat(element.getAttribute('height')) || 2;
            const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
            const material = new THREE.MeshStandardMaterial({ color: 0x88ffaa });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'cylinder';
            return mesh;
        }

        parseCone(element) {
            const radius = parseFloat(element.getAttribute('radius')) || 1;
            const height = parseFloat(element.getAttribute('height')) || 2;
            const geometry = new THREE.ConeGeometry(radius, height, 32);
            const material = new THREE.MeshStandardMaterial({ color: 0xffd43b });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'cone';
            return mesh;
        }

        parseTorus(element) {
            const radius = parseFloat(element.getAttribute('radius')) || 1;
            const tube = parseFloat(element.getAttribute('tube')) || 0.3;
            const geometry = new THREE.TorusGeometry(radius, tube, 16, 32);
            const material = new THREE.MeshStandardMaterial({ color: 0xff6b6b });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'torus';
            return mesh;
        }

        parsePlane(element) {
    const scale = this.parseVector3(element.getAttribute('scale'), [10, 10, 1]);
    const geometry = new THREE.PlaneGeometry(scale[0], scale[1]);
    const color = element.getAttribute('color') || '#333344';
    const opacity = parseFloat(element.getAttribute('opacity')) || 1;
    const material = new THREE.MeshStandardMaterial({
        color: color,
        transparent: opacity < 1,
        opacity: opacity,
        side: THREE.DoubleSide,
        roughness: 0.8
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.name = 'plane';
    mesh.userData.isGround = true;
    mesh.userData.anchor = true;
          const rotAttr = element.getAttribute('rotation');
if (rotAttr) {
    const rot = this.parseVector3(rotAttr, [0, 0, 0]);
    mesh.rotation.set(rot[0] * Math.PI / 180, rot[1] * Math.PI / 180, rot[2] * Math.PI / 180);
}
          
    return mesh;
        }

        parseGroup(element) {
            const group = new THREE.Group();
            group.name = 'group';
            return group;
        }

        parseLabel(element) {
    const htmlContent = element.innerHTML || element.getAttribute('text') || 'Label';
    const position = this.parseVector3(element.getAttribute('position'), [0, 0, 0]);
    
    // ✅ قراءة الخصائص من CSS (getComputedStyle)
    const computed = getComputedStyle(element);
    
    // ===== دالة مساعدة لقراءة الخصائص =====
    // تبحث في: 1. CSS المباشر، 2. CSS مع --، 3. attributes
    function getCSSProp(propName, attrName, defaultValue) {
        // 1️⃣ محاولة قراءة الخاصية مباشرة من CSS
        let value = computed.getPropertyValue(propName);
        if (value && value !== '') return value.trim();
        
        // 2️⃣ محاولة قراءة الخاصية مع -- (custom property)
        value = computed.getPropertyValue(`--${propName}`);
        if (value && value !== '') return value.trim();
        
        // 3️⃣ محاولة قراءة من attribute
        if (attrName) {
            value = element.getAttribute(attrName);
            if (value !== null) return value;
        }
        
        return defaultValue;
    }
    
    // ===== قراءة الخصائص =====
    // خصائص CSS قياسية
    const color = getCSSProp('color', 'color', '#ffffff');
    const border = getCSSProp('border', 'border', '2px solid rgba(255,255,255,0.2)');
    const bg = getCSSProp('background', 'background', 'rgba(0,0,0,0.7)');
    const textShadow = getCSSProp('text-shadow', 'textShadow', 'none');
    const padding = getCSSProp('padding', 'padding', '8px 16px');
    const borderRadius = getCSSProp('border-radius', 'border-radius', '12px');
    const fontSize = getCSSProp('font-size', 'size', '16px');
    const fontFamily = getCSSProp('font-family', 'font-family', 'Arial, sans-serif');
    const opacity = parseFloat(getCSSProp('opacity', 'opacity', '1')) || 1;
    const visibility = getCSSProp('visibility', 'visibility', 'visible') !== 'hidden';
    
    // ✅ خصائص مخصصة (بدون --) - position, scale, max-distance
    const posX = parseFloat(getCSSProp('position-x', null, '0'));
    const posY = parseFloat(getCSSProp('position-y', null, '0'));
    const posZ = parseFloat(getCSSProp('position-z', null, '0'));
    const scale = parseFloat(getCSSProp('scale', 'scale', '1')) || 1;
    const maxDistance = parseFloat(getCSSProp('max-distance', 'max-distance', '-1')) || -1;
    
    // إذا كان هناك position في CSS، استخدمه بدلاً من attribute
    const finalPosition = (posX !== 0 || posY !== 0 || posZ !== 0) 
        ? [posX, posY, posZ] 
        : position;
    
    const className = element.getAttribute('class') || '';
    const id = element.getAttribute('id') || '';
    
    // ✅ إنشاء الحاوية الخارجية
    const container = document.createElement('div');
    container.innerHTML = htmlContent;
    
    // ✅ تنسيق الحاوية
    container.style.cssText = `
        display: inline-block;
        min-width: 50px;
        min-height: 20px;
        color: ${color};
        font-size: ${fontSize};
        font-family: ${fontFamily};
        text-shadow: ${textShadow};
        background: ${bg};
        padding: ${padding};
        border-radius: ${borderRadius};
        border: ${border};
        backdrop-filter: blur(4px);
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        pointer-events: none;
        width: auto;
        height: auto;
        max-width: 300px;
        max-height: 200px;
        overflow: visible;
        opacity: ${opacity};
    `;
    
    if (className) container.className = className;
    if (id) container.id = id;
    let label;
    // ✅ إنشاء CSS2DObject
    if (CSS2DObject) {
     label = new CSS2DObject(container);
    label.position.set(finalPosition[0], finalPosition[1], finalPosition[2]);
    label.scale.set(scale, scale, 1);
    label.visible = visibility;
    
    const anchor = element.getAttribute('anchor');
    if (anchor !== null) {
        label.userData.anchorToParent = (anchor !== 'false');
    }
    
    label.userData.isLabel = true;
    label.userData.maxDistance = maxDistance;
    label.userData.labelId = id || 'label-' + Date.now();
    label.userData.labelClass = className;
    label.userData.domElement = element;
    label.userData.sourceElement = element;
          } else {
        warnFeatureOnce('css2d-label', 'CSS2DObject unavailable — <label> elements are skipped.');
    }
    return label;
}

 handleAction(action, element) {
    if (action === 'jump' && Html3D.playerController) {
        Html3D.playerController.jump();
    } else if (action === 'fire' && window.fire) {
        window.fire();
    } else if (action.startsWith('alert:')) {
        alert(action.split(':')[1]);
    } else if (action.startsWith('switch:')) {
        const page = action.split(':')[1];
        if (window.switchPage) window.switchPage(page);
    } else if (action === 'reload') {
        window.location.reload();
    } else {
        console.warn(`⚠️ Unknown action: ${action}`);
    }
}
      
      parseButton(element) {
    const text = element.textContent || element.getAttribute('text') || 'Button';
    const position = this.parseVector3(element.getAttribute('position'), [0, 0, 0]);
    const color = element.getAttribute('color') || '#3498db';
    const textColor = element.getAttribute('text-color') || '#ffffff';
    const size = parseFloat(element.getAttribute('size')) || 1;
    const action = element.getAttribute('action') || 'click';
    
    // إنشاء زر HTML
    const btn = document.createElement('button');
    btn.textContent = text;
    
    // ✅ لا تستخدم transform أبداً في CSS
    btn.style.cssText = `
        background: ${color};
        color: ${textColor};
        border: 2px solid rgba(255,255,255,0.3);
        padding: 8px 18px;
        border-radius: 10px;
        font-size: ${size * 16}px;
        font-weight: bold;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        pointer-events: auto;
        font-family: Arial, sans-serif;
        transition: none;
        backdrop-filter: blur(4px);
        /* ❌ لا تستخدم transform: scale() */
        /* ❌ لا تستخدم transition على transform */
    `;
    
    // ✅ تأثيرات لا تستخدم transform
    btn.addEventListener('mouseenter', () => {
        btn.style.boxShadow = '0 6px 25px rgba(0,0,0,0.6)';
        btn.style.border = `2px solid ${color}`;
        btn.style.filter = 'brightness(1.15)';
        btn.style.opacity = '0.9';
    });
    
    btn.addEventListener('mouseleave', () => {
        btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
        btn.style.border = '2px solid rgba(255,255,255,0.3)';
        btn.style.filter = 'brightness(1)';
        btn.style.opacity = '1';
    });
    
    // ✅ تأثير الضغط (بدون transform)
    btn.addEventListener('mousedown', () => {
        btn.style.opacity = '0.6';
        btn.style.filter = 'brightness(0.85)';
    });
    
    btn.addEventListener('mouseup', () => {
        btn.style.opacity = '1';
        btn.style.filter = 'brightness(1)';
    });
    
    // ✅ دعم اللمس
    btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        btn.style.opacity = '0.6';
        btn.style.filter = 'brightness(0.85)';
    });
    
    btn.addEventListener('touchend', () => {
        btn.style.opacity = '1';
        btn.style.filter = 'brightness(1)';
        btn.click();
    });
    
    // معالج النقر
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // console.log(`🔘 ${text} clicked`);
        this.handleAction(action, btn);
    });
        let label
    if (CSS2DObject) {
    label = new CSS2DObject(btn);
    label.position.set(position[0], position[1], position[2]);
    label.userData.isLabel = true;
    label.userData.interactive = true;
    } else {
        warnFeatureOnce('css2d-label', 'CSS2DObject unavailable — <button> elements are skipped.');
    }
    return label;
}

// دالة مساعدة لمعالجة الأكشنات


        applyAttributes(element, threeObject) {
    // Position
    const pos = this.parseVector3(element.getAttribute('position'), [0, 0, 0]);
    threeObject.position.set(pos[0], pos[1], pos[2]);

    // Rotation
    const rot = this.parseVector3(element.getAttribute('rotation'), [0, 0, 0]);
    threeObject.rotation.set(rot[0] * Math.PI / 180, rot[1] * Math.PI / 180, rot[2] * Math.PI / 180);

    // Scale
    const scale = this.parseVector3(element.getAttribute('scale'), [1, 1, 1]);
    threeObject.scale.set(scale[0], scale[1], scale[2]);

    // ✅ Color (مع التأكد من تحديث المادة)
    const color = element.getAttribute('color');
    if (color && threeObject.isMesh) {
        const colorObj = new THREE.Color(color);
        threeObject.material.color.copy(colorObj);
        threeObject.material.needsUpdate = true;  // ✅ هام جداً
    }

    // ✅ خصائص الإضاءة (لم تكن مدعومة سابقاً — كل الأضواء كانت تُهمَل هنا)
    if (threeObject.isLight) {
        if (color && threeObject.color) {
            threeObject.color.set(new THREE.Color(color));
        }
        const intensityAttr = element.getAttribute('intensity');
        if (intensityAttr !== null) threeObject.intensity = parseFloat(intensityAttr);

        if ('distance' in threeObject) {
            const d = element.getAttribute('distance');
            if (d !== null) threeObject.distance = parseFloat(d);
        }
        if ('angle' in threeObject) {
            const a = element.getAttribute('angle');
            if (a !== null) threeObject.angle = parseFloat(a);
        }
        if ('penumbra' in threeObject) {
            const p = element.getAttribute('penumbra');
            if (p !== null) threeObject.penumbra = parseFloat(p);
        }
        if ('decay' in threeObject) {
            const dc = element.getAttribute('decay');
            if (dc !== null) threeObject.decay = parseFloat(dc);
        }
        if (threeObject.groundColor) {
            const gc = element.getAttribute('ground-color');
            if (gc !== null) threeObject.groundColor.set(new THREE.Color(gc));
        }
        // إضاءات موجّهة (Directional/Spot): نحوّل rotation إلى موضع target
        if (threeObject.target) {
            if (!threeObject.target.parent && this.scene) this.scene.add(threeObject.target);
            const forward = new THREE.Vector3(0, 0, -1);
            forward.applyQuaternion(threeObject.quaternion);
            threeObject.target.position.copy(threeObject.position).add(forward);
            threeObject.target.updateMatrixWorld();
        }
    }

    // ✅ إذا كانت المادة من نوع MeshStandardMaterial، تأكد من وجود إضاءة
    if (threeObject.isMesh && threeObject.material.type === 'MeshStandardMaterial') {
        // لا حاجة لفعل شيء، الإضاءة موجودة بالفعل
    }

    // Name
    const name = element.getAttribute('name') || element.id || '';
    if (name) {
        threeObject.name = name;
    }
}

// ===== تحليل وسوم الإضاءة (<directional-light>, <point-light>, ...) =====
parseLight(element, type) {
    switch (type) {
        case 'ambient':
            return new THREE.AmbientLight(0xffffff, 1);
        case 'directional':
            return new THREE.DirectionalLight(0xffffff, 1);
        case 'point':
            return new THREE.PointLight(0xffffff, 1, 0);
        case 'spot':
            return new THREE.SpotLight(0xffffff, 1);
        case 'hemisphere':
            return new THREE.HemisphereLight(0xffffff, 0x444444, 1);
        default:
            return null;
    }
}

        parseVector3(value, defaultValue) {
            if (!value) return defaultValue;
            const parts = value.split(' ').map(Number);
            if (parts.length === 1) return [parts[0], parts[0], parts[0]];
            if (parts.length === 2) return [parts[0], parts[1], 0];
            if (parts.length >= 3) return [parts[0], parts[1], parts[2]];
            return defaultValue;
        }

        setScene(scene) {
            this.scene = scene;
        }
    }

    // ============================================================
    //  5. CSS Handler (جديد) - يقرأ CSS ويطبقها على الكائنات
    // ============================================================
    class CssHandler {
        constructor(parser) {
            this.parser = parser;
            this.styleMap = new Map();
        }

        applyStyles(element, threeObject) {
            const computed = getComputedStyle(element);
            
            // قراءة الخصائص المدعومة
            const color = computed.getPropertyValue('color');
            if (color && color !== 'rgb(0, 0, 0)') {
                const colorObj = new THREE.Color(color);
                if (threeObject.isMesh) {
                    threeObject.material.color.copy(colorObj);
                }
            }

            const roughness = computed.getPropertyValue('--roughness') || computed.getPropertyValue('roughness');
            if (roughness && threeObject.isMesh) {
                threeObject.material.roughness = parseFloat(roughness);
            }

            const metalness = computed.getPropertyValue('--metalness') || computed.getPropertyValue('metalness');
            if (metalness && threeObject.isMesh) {
                threeObject.material.metalness = parseFloat(metalness);
            }

            const opacity = computed.getPropertyValue('opacity');
            if (opacity && threeObject.isMesh) {
                threeObject.material.opacity = parseFloat(opacity);
                threeObject.material.transparent = parseFloat(opacity) < 1;
            }

            // Scale من CSS
            const scale = computed.getPropertyValue('--scale') || computed.getPropertyValue('scale');
            if (scale) {
                const parts = scale.split(' ').map(Number);
                if (parts.length === 1) {
                    threeObject.scale.set(parts[0], parts[0], parts[0]);
                } else if (parts.length >= 3) {
                    threeObject.scale.set(parts[0], parts[1], parts[2]);
                }
            }

            // تحديث المواد
            if (threeObject.isMesh) {
                threeObject.material.needsUpdate = true;
            }
        }
    }

    // ============================================================
    //  6. Event Binder (جديد) - يربط أحداث DOM بأحداث Three.js
    // ============================================================
    class EventBinder {
        constructor(renderer, camera, scene, parser) {
            this.renderer = renderer;
            this.camera = camera;
            this.scene = scene;
            this.parser = parser;
            this.raycaster = new THREE.Raycaster();
            this.mouse = new THREE.Vector2();
            this.hoveredElement = null;
            this.isDragging = false;
            this.dragStart = null;

            this.bindEvents();
        }
        
        // ===== دوال اللمس (للجوال) =====
onTouchStart(event) {
    // تحويل حدث اللمس إلى حدث فأرة مؤقت
    const touch = event.touches[0];
    if (!touch) return;
    const mouseEvent = new MouseEvent('pointerdown', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    this.onPointerDown(mouseEvent);
}

onTouchMove(event) {
    const touch = event.touches[0];
    if (!touch) return;
    const mouseEvent = new MouseEvent('pointermove', {
        clientX: touch.clientX,
        clientY: touch.clientY
    });
    this.onPointerMove(mouseEvent);
}

onTouchEnd(event) {
    const mouseEvent = new MouseEvent('pointerup', {
        clientX: this.dragStart?.x || 0,
        clientY: this.dragStart?.y || 0
    });
    this.onPointerUp(mouseEvent);
}

        // في EventBinder.bindEvents()
bindEvents() {
    const canvas = this.renderer.domElement;
    
    // دعم اللمس
    
    
    // دعم الفأرة (للحاسوب)
    canvas.addEventListener('pointerdown', this.onPointerDown.bind(this));
    canvas.addEventListener('pointerup', this.onPointerUp.bind(this));
    canvas.addEventListener('pointermove', this.onPointerMove.bind(this));
    canvas.addEventListener('click', this.onClick.bind(this));
    canvas.addEventListener('dblclick', this.onDblClick.bind(this));
    
    canvas.addEventListener('touchstart', this.onTouchStart.bind(this));
    canvas.addEventListener('touchmove', this.onTouchMove.bind(this));
    canvas.addEventListener('touchend', this.onTouchEnd.bind(this));
}

        getIntersectedObject(event) {
            const rect = this.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.camera);
            const intersects = this.raycaster.intersectObjects(this.scene.children, true);

            if (intersects.length > 0) {
                let object = intersects[0].object;
                // البحث عن الكائن الأب الذي له DOM element
                while (object && !object.userData?.domElement) {
                    object = object.parent;
                }
                return object;
            }
            return null;
        }

        getDomElement(threeObject) {
            if (!threeObject) return null;
            return threeObject.userData?.domElement || null;
        }

        triggerEvent(domElement, eventType, originalEvent) {
            if (!domElement) return;
            const event = new MouseEvent(eventType, originalEvent);
            domElement.dispatchEvent(event);
        }

        onPointerDown(event) {
            this.isDragging = false;
            this.dragStart = { x: event.clientX, y: event.clientY };
            
            const obj = this.getIntersectedObject(event);
            const domEl = this.getDomElement(obj);
            if (domEl) {
                this.triggerEvent(domEl, 'mousedown', event);
                this.triggerEvent(domEl, 'pointerdown', event);
            }
        }

        onPointerUp(event) {
            const dx = event.clientX - this.dragStart.x;
            const dy = event.clientY - this.dragStart.y;
            if (Math.sqrt(dx*dx + dy*dy) > 5) {
                this.isDragging = true;
            }

            const obj = this.getIntersectedObject(event);
            const domEl = this.getDomElement(obj);
            if (domEl) {
                this.triggerEvent(domEl, 'mouseup', event);
                this.triggerEvent(domEl, 'pointerup', event);
                if (this.isDragging) {
                    this.triggerEvent(domEl, 'dragend', event);
                }
            }
        }

        onPointerMove(event) {
            const obj = this.getIntersectedObject(event);
            const domEl = this.getDomElement(obj);
            
            // Hover
            if (this.hoveredElement !== domEl) {
                if (this.hoveredElement) {
                    this.triggerEvent(this.hoveredElement, 'mouseleave', event);
                }
                this.hoveredElement = domEl;
                if (domEl) {
                    this.triggerEvent(domEl, 'mouseenter', event);
                }
            }
            
            if (domEl) {
                this.triggerEvent(domEl, 'mousemove', event);
                this.triggerEvent(domEl, 'pointermove', event);
                
                // Drag
                if (event.buttons > 0 && !this.isDragging) {
                    const dx = event.clientX - this.dragStart.x;
                    const dy = event.clientY - this.dragStart.y;
                    if (Math.sqrt(dx*dx + dy*dy) > 5) {
                        this.isDragging = true;
                        this.triggerEvent(domEl, 'dragstart', event);
                    }
                }
                if (this.isDragging) {
                    this.triggerEvent(domEl, 'drag', event);
                }
            }
        }

        onClick(event) {
            const obj = this.getIntersectedObject(event);
            const domEl = this.getDomElement(obj);
            if (domEl) {
                this.triggerEvent(domEl, 'click', event);
            }
        }

        onDblClick(event) {
            const obj = this.getIntersectedObject(event);
            const domEl = this.getDomElement(obj);
            if (domEl) {
                this.triggerEvent(domEl, 'dblclick', event);
            }
        }
    }
    
    // ============================================================
//  9. Player Controller (نظام التحكم والفيزياء)
// ============================================================
    class PlayerController {
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.player = null;
        this.isActive = false;
        // أهداف زوايا الكاميرا (لـ damping)
this.targetTheta = 0;
this.targetPhi = 0.3;
this.isDragging = false;
      this.body = null;
        this.options = {
            speed: 5,
            jumpPower: 8,
            gravity: -20,
            cameraDistance: 8,
            cameraHeight: 2,
            perspective: 3, // 1=1st, 2=2nd, 3=3rd
            enableJump: true,
            enablePhysics: true,
            cameraSensitivity: 0.005,   // حساسية السحب (قلل للبطء، زد للسرعة)
    cameraDamping: 0.08,        // تخميد الحركة (0 = بدون، 1 = توقف فوري)
    invertY: false,            // عكس اتجاه السحب العمودي
    minPitch: -Math.PI/2.2,    // الحد الأدنى لزاوية الصعود
    maxPitch: Math.PI/2.2, 
          faceCamera: false,
        };
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.body = null; // مرجع الجسم الفيزيائي
        this.onGround = false;
        this.isOnGround = false;
        this.cameraRotation = { theta: 0, phi: 0 }; // تدوير الكاميرا
        this.moveDirection = { x: 0, z: 0 };
        this.isJumping = false;

        // عناصر الـ UI
        this.analogStick = null;
        this.analogKnob = null;
        this.analogContainer = null;

        this.setupUI();
        this.setupEvents();
    }

    setupUI() {
        // إنشاء حاوية العصا
        this.analogContainer = document.createElement('div');
        this.analogContainer.style.cssText = `
            position: fixed;
            bottom: 40px;
            left: 40px;
            width: 120px;
            height: 120px;
            border-radius: 50%;
            background: rgba(255,255,255,0.1);
            border: 2px solid rgba(255,255,255,0.2);
            touch-action: none;
            z-index: 100;
            display: flex;
            justify-content: center;
            align-items: center;
            box-shadow: 0 0 30px rgba(0,0,0,0.5);
            backdrop-filter: blur(5px);
        `;
        // المقبض
        this.analogKnob = document.createElement('div');
        this.analogKnob.style.cssText = `
            width: 50px;
            height: 50px;
            border-radius: 50%;
            background: rgba(255,255,255,0.3);
            border: 2px solid rgba(255,255,255,0.4);
            position: absolute;
            transition: transform 0.05s;
            pointer-events: none;
        `;
        this.analogContainer.appendChild(this.analogKnob);
        document.body.appendChild(this.analogContainer);

        // إضافة دائرتين لتحديد المركز
        const centerDot = document.createElement('div');
        centerDot.style.cssText = `
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: rgba(255,255,255,0.3);
            position: absolute;
        `;
        this.analogContainer.appendChild(centerDot);

        // منطقة سحب الكاميرا (تغطي باقي الشاشة)
        this.cameraDragArea = document.createElement('div');
        this.cameraDragArea.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 50;
            touch-action: none;
            pointer-events: none;
        `;
        // نجعلها تلتقط الأحداث فقط إذا لم تكن فوق العصا
        this.cameraDragArea.style.pointerEvents = 'auto';
        document.body.appendChild(this.cameraDragArea);
    }

    setupEvents() {
        // أحداث العصا
        let stickActive = false;
        let stickTouchId = null;
        const stickCenter = { x: 0, y: 0 };

        this.analogContainer.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            if (!touch) return;
            stickTouchId = touch.identifier;
            stickActive = true;
            const rect = this.analogContainer.getBoundingClientRect();
            stickCenter.x = rect.left + rect.width / 2;
            stickCenter.y = rect.top + rect.height / 2;
            this.updateStick(touch.clientX, touch.clientY);
        }, { passive: false });

        this.analogContainer.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = Array.from(e.touches).find(t => t.identifier === stickTouchId);
            if (!touch) return;
            this.updateStick(touch.clientX, touch.clientY);
        }, { passive: false });

        // في touchend
this.analogContainer.addEventListener('touchend', (e) => {
    e.preventDefault();
    stickActive = false;
    stickTouchId = null;
    
    // ✅ إعادة تعيين قوية
    this.moveDirection.x = 0;
    this.moveDirection.z = 0;
    this.body.velocity.x = 0;
this.body.velocity.z = 0;
    this.analogKnob.style.transform = `translate(0px, 0px)`;
    
    // ✅ إيقاف السرعة فوراً (للتأكد)
    if (this.body) {
        this.body.velocity.x = 0;
        this.body.velocity.z = 0;
    }
}, { passive: false });

// في touchcancel
this.analogContainer.addEventListener('touchcancel', (e) => {
    stickActive = false;
    stickTouchId = null;
    
    // ✅ إعادة تعيين قوية
    this.moveDirection.x = 0;
    this.moveDirection.z = 0;
    this.analogKnob.style.transform = `translate(0px, 0px)`;
    
    if (this.body) {
        this.body.velocity.x = 0;
        this.body.velocity.z = 0;
    }
}, { passive: false });

        // أحداث سحب الكاميرا
        // أحداث سحب الكاميرا (مع damping)
let isDragging = false;
let lastX = 0, lastY = 0;
this.targetTheta = this.cameraRotation.theta;
this.targetPhi = this.cameraRotation.phi;

this.cameraDragArea.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const el = document.elementFromPoint(touch.clientX, touch.clientY);
    if (el && this.analogContainer.contains(el)) return;
    isDragging = true;
    lastX = touch.clientX;
    lastY = touch.clientY;
    // إيقاف damping مؤقتاً أثناء السحب
    this.isDragging = true;
}, { passive: true });

this.cameraDragArea.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - lastX;
    const dy = touch.clientY - lastY;
    
    // تطبيق الحساسية مع إمكانية عكس المحور Y
    const sensitivity = this.options.cameraSensitivity;
    const invertY = this.options.invertY ? -1 : 1;
    
    this.targetTheta += dx * sensitivity;
    this.targetPhi += dy * sensitivity * invertY;
    
    // تطبيق الحدود القصوى
    this.targetPhi = Math.max(this.options.minPitch, Math.min(this.options.maxPitch, this.targetPhi));
    
    lastX = touch.clientX;
    lastY = touch.clientY;
}, { passive: true });

this.cameraDragArea.addEventListener('touchend', () => {
    isDragging = false;
    this.isDragging = false;
}, { passive: true });

this.cameraDragArea.addEventListener('touchcancel', () => {
    isDragging = false;
    this.isDragging = false;
}, { passive: true });

// دعم الفأرة (للحاسوب) بنفس الطريقة
this.cameraDragArea.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && this.analogContainer.contains(el)) return;
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    this.isDragging = true;
});

window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    const sensitivity = this.options.cameraSensitivity;
    const invertY = this.options.invertY ? -1 : 1;
    this.targetTheta += dx * sensitivity;
    this.targetPhi += dy * sensitivity * invertY;
    this.targetPhi = Math.max(this.options.minPitch, Math.min(this.options.maxPitch, this.targetPhi));
    lastX = e.clientX;
    lastY = e.clientY;
});

window.addEventListener('mouseup', () => {
    isDragging = false;
    this.isDragging = false;
});
    }

    updateStick(clientX, clientY) {
        const rect = this.analogContainer.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const maxRadius = rect.width / 2 - 15;
        let dx = clientX - cx;
        let dy = clientY - cy;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > maxRadius) {
            dx = dx / dist * maxRadius;
            dy = dy / dist * maxRadius;
        }
        this.analogKnob.style.transform = `translate(${dx}px, ${dy}px)`;
        // اتجاه الحركة
        const normX = dx / maxRadius;
        const normY = dy / maxRadius;
        this.moveDirection.x = normX;
        this.moveDirection.z = normY; // لأن الاتجاه Y للأعلى على الشاشة يعكس السالب في الفضاء
        // ✅ إذا كانت القيم صغيرة جداً، اعتبرها صفراً (لتجنب "التشويش")
if (Math.abs(this.moveDirection.x) < 0.01) this.moveDirection.x = 0;
if (Math.abs(this.moveDirection.z) < 0.01) this.moveDirection.z = 0;
    }

    setPlayer(object, options = {}, faceCamera = undefined) {
    this.player = object;
    this.isActive = true;
    Object.assign(this.options, options);
    // ✅ لا نستبدل this.options.faceCamera إلا إذا مُرِّر الوسيط صراحة —
    // وإلا نُبقي القيمة التي وصلت بالفعل عبر options (انظر التعليق في
    // Html3D.setPlayer الثابتة حول سبب هذا التغيير)
    if (faceCamera !== undefined) {
        this.options.faceCamera = faceCamera;
    }

    // ✅ نحسب نصف ارتفاع اللاعب الفعلي من صندوقه المحيط (بدل الاعتماد على
    // قيم ثابتة عشوائية في فحص الأرض) — هذا هو أساس إصلاح مشاكل: القفز الذي
    // لا يعمل أثناء الوقوف الثابت على منصة، التسلّق البطيء على الجدران،
    // واهتزاز الحركة فوق الأرض المستوية (انظر _checkGrounded أدناه).
    const boundingBox = new THREE.Box3().setFromObject(object);
    this.playerHalfHeight = Math.max(0.1, (boundingBox.max.y - boundingBox.min.y) / 2);
    
    // ✅ إضافة الجسم الفيزيائي للاعب
    if (Html3D.physicsManager && Html3D.physicsManager.enabled) {
        // نحدد الشكل حسب حجم اللاعب
        const shape = Html3D.physicsManager.detectShape(object);
        // نمرر الكتلة كخيار (يمكن تعديلها من options)
        const mass = options.mass || 1;
        const friction = options.friction || 0.3;
        const restitution = options.restitution || 0.1;
        this.body = Html3D.physicsManager.addBody(object, shape, {
            mass: mass,
            friction: friction,
            restitution: restitution,
            linearDamping: 0.05,
            angularDamping: 0.9
        });
        // تثبيت دوران اللاعب (يمنع الميلان)
if (this.body) {
    this.body.fixedRotation = true; // يمنع الدوران حول المحاور X و Z
    // اختيارياً: منع الدوران تماماً (إذا كنت تريد التحكم اليدوي بالدوران)
    this.body.quaternion.set(0, 0, 0, 1); // إعادة تعيين الدوران
}
        // منع دوران اللاعب (للألعاب المنظورية)
        if (this.body) {
            this.body.fixedRotation = true;
            // تعيين سرعة ابتدائية صفرية
            this.body.velocity.set(0, 0, 0);
        }
    } else {
        console.warn('Physics not enabled. Player will not have physics.');
    }
    
    // وضع الكاميرا الأولي
    this.cameraRotation.theta = 0;
    this.cameraRotation.phi = 0.3;
    this.cameraRotation.theta = 0;
this.cameraRotation.phi = 0.3;
this.targetTheta = 0;
this.targetPhi = 0.3;
this.isDragging = false;
    this.updateCamera();
    
    // إظهار العصا
    this.analogContainer.style.display = 'flex';
    this.cameraDragArea.style.pointerEvents = 'auto';
    this.player.userData.isPlayer = true;
}

    togglePerspective(mode) {
        this.options.perspective = mode;
        this.updateCamera();
    }

    // تعيين FOV جديد
setFOV(fov) {
    if (!this.camera) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateProjectionMatrix(); // تأكيد التحديث
}

// الحصول على FOV الحالي
getFOV() {
    if (!this.camera) return 60;
    return this.camera.fov;
}

// إضافة/طرح من FOV الحالي
addFOV(delta) {
    if (!this.camera) return;
    this.camera.fov += delta;
    this.camera.fov = Math.max(1, Math.min(179, this.camera.fov)); // حدود آمنة
    this.camera.updateProjectionMatrix();
}

// إعادة تعيين FOV إلى القيمة الافتراضية
resetFOV(defaultFov = 60) {
    if (!this.camera) return;
    this.camera.fov = defaultFov;
    this.camera.updateProjectionMatrix();
}

// تغيير FOV مع تأثير تدريجي (تأثير الزوم)
setFOVSmooth(targetFov, duration = 500) {
    if (!this.camera) return;
    
    const startFov = this.camera.fov;
    const startTime = Date.now();
    
    // إلغاء أي تأثير سابق
    if (this._fovAnimation) {
        cancelAnimationFrame(this._fovAnimation);
    }
    
    const animateFOV = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // دالة easing (تسارع تدريجي)
        const ease = 1 - Math.pow(1 - progress, 3);
        
        const currentFov = startFov + (targetFov - startFov) * ease;
        this.camera.fov = currentFov;
        this.camera.updateProjectionMatrix();
        
        if (progress < 1) {
            this._fovAnimation = requestAnimationFrame(animateFOV);
        } else {
            this.camera.fov = targetFov;
            this.camera.updateProjectionMatrix();
            this._fovAnimation = null;
        }
    };
    
    animateFOV();
}

    // ============================================================
    //  فحص وقوف اللاعب على الأرض — مصدر واحد موحّد يستخدمه كل من
    //  updatePhysics() و jump()، بدل نسختين مستقلتين بثوابت مختلفة (كانتا
    //  السبب في تعطّل القفز أثناء الوقوف الثابت). المسافة تُحسب بالنسبة
    //  لنصف ارتفاع اللاعب الفعلي (playerHalfHeight) بدل أرقام عشوائية، كما
    //  تُرفض أي أسطح شبه رأسية (جدران) حتى لا تُصنَّف كأرض بالخطأ.
    // ============================================================
    _checkGrounded() {
        if (!this.player) return { onGround: false, groundY: -Infinity, hit: null };

        const halfHeight = this.playerHalfHeight || 0.5;
        const skin = 0.12; // هامش يمتص فجوات/تراكب بسيطة ناتجة عن محرك الفيزياء

        const raycaster = new THREE.Raycaster();
        const origin = this.player.position.clone();
        const direction = new THREE.Vector3(0, -1, 0);
        raycaster.set(origin, direction);
        raycaster.far = halfHeight + skin + 0.15;

        const meshes = [];
        this.scene.traverse(child => {
            if (child.isMesh && child !== this.player) {
                if (child.userData.isGround === false) return;
                if (child.material && child.material.transparent && child.material.opacity < 0.1) return;
                meshes.push(child);
            }
        });

        const intersects = raycaster.intersectObjects(meshes, false);
        for (const hit of intersects) {
            if (hit.distance > halfHeight + skin) continue;

            // نتجاهل أي سطح مائل بشدة (جدار أو منحدر حاد) — هذا هو ما كان
            // يجعل ملامسة حافة جدار تُحتسب "أرضاً" فتُلغي تأثير الجاذبية
            // وتُنتج تسلّقاً بطيئاً للجدار
            let normal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 1, 0);
            if (hit.object) {
                const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
                normal.applyMatrix3(normalMatrix).normalize();
            }
            if (normal.y < 0.6) continue; // أكثر ميلاناً من ~53° عن الأفقي

            return { onGround: true, groundY: hit.point.y, hit };
        }
        return { onGround: false, groundY: -Infinity, hit: null };
    }

    updatePhysics(delta) {
    if (!this.isActive || !this.player || !this.body) return;

    const dt = Math.min(delta, 0.05);
    const speed = this.options.speed;
    const jumpPower = this.options.jumpPower;

    // ----- 1. إيقاظ الجسم -----
    this.body.wakeUp();

    // ----- 2. كشف الأرض بدقة (نفس منطق _checkGrounded المستخدم أيضاً في jump()) -----
    const groundCheck = this._checkGrounded();

    // تخزين الحالة السابقة لتتبع تغيير الحالة
    const wasOnGround = this.onGround;
    this.onGround = groundCheck.onGround;

    // نتدخل فقط لمنع تراكم سرعة سقوط كبيرة جداً أثناء لمس الأرض (يمنع
    // اختراق السطح عند هبوط مفاجئ من ارتفاع) — ولا نتدخل إطلاقاً إن كانت
    // السرعة الرأسية قريبة من الصفر أو موجبة، بل نترك محرك الفيزياء
    // (cannon) يتولى استقرار التلامس بنفسه بالكامل عبر خطواته الثابتة.
    // إجبار سرعة رأسية طفيفة (سالبة) في *كل* إطار كان هو نفسه سبب دورة
    // "غرق بسيط ← دفعة تصحيح من المحرك ← غرق مجدداً..." المتكررة، لأنه
    // كان يتعارض مع تصحيح محرك الفيزياء لنفس المحور في كل خطوة.
    if (this.onGround && this.body.velocity.y < -4) {
        this.body.velocity.y = -4;
    }

    // ----- 3. اتجاه الحركة من العصا -----
    const forward = new THREE.Vector3(Math.sin(this.cameraRotation.theta), 0, Math.cos(this.cameraRotation.theta));
    const right = new THREE.Vector3(Math.cos(this.cameraRotation.theta), 0, -Math.sin(this.cameraRotation.theta));

    const moveX = this.moveDirection.x * right.x + this.moveDirection.z * forward.x;
    const moveZ = this.moveDirection.x * right.z + this.moveDirection.z * forward.z;

    const targetVx = moveX * speed;
    const targetVz = moveZ * speed;

    // ----- 4. تسارع محدود للسرعة الأفقية -----
    const acceleration = 0.15;
    this.body.velocity.x += (targetVx - this.body.velocity.x) * acceleration;
    this.body.velocity.z += (targetVz - this.body.velocity.z) * acceleration;

    // إذا كانت السرعة المستهدفة صغيرة، أوقف الحركة تدريجياً
    if (Math.abs(moveX) < 0.01 && Math.abs(moveZ) < 0.01) {
        this.body.velocity.x *= 0.95;
        this.body.velocity.z *= 0.95;
        if (Math.abs(this.body.velocity.x) < 0.01) this.body.velocity.x = 0;
        if (Math.abs(this.body.velocity.z) < 0.01) this.body.velocity.z = 0;
    }

    // ----- 5. القفز (محسّن) -----
    if (this.isJumping && this.onGround) {
        this.body.velocity.y = jumpPower;
        this.isJumping = false;
        this.onGround = false;
        
        // إضافة تأثير صوتي أو بصري اختياري
        // console.log('🏃 Jump!');
    }

    // ----- 6. تدوير اللاعب (faceCamera) -----
    if (this.options.faceCamera) {
        // دوران سلس نحو اتجاه الكاميرا
        const targetAngle = this.cameraRotation.theta;
        let currentAngle = this.player.rotation.y;
        
        // حساب الفرق مع مراعاة الالتفاف (wrapping)
        let diff = targetAngle - currentAngle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        
        // دوران تدريجي (لمنع الحركة المفاجئة)
        const rotationSpeed = 0.1;
        this.player.rotation.y += diff * Math.min(rotationSpeed, 1);
        
        // مزامنة مع الفيزياء
        this.body.quaternion.setFromAxisAngle(
            new CANNON.Vec3(0, 1, 0), 
            this.player.rotation.y
        );
    } else {
        // التدوير حسب اتجاه الحركة
        if (Math.abs(this.body.velocity.x) > 0.1 || Math.abs(this.body.velocity.z) > 0.1) {
            const angle = Math.atan2(this.body.velocity.x, this.body.velocity.z);
            this.player.rotation.y = angle;
            this.body.quaternion.setFromAxisAngle(
                new CANNON.Vec3(0, 1, 0), 
                angle
            );
        }
    }

    // ----- 7. تحديث الكاميرا (مع مراعاة faceCamera) -----
    this.updateCamera();
}

    updateCamera() {
    if (!this.isActive || !this.player) return;
    
    // تطبيق الـ damping على زوايا الكاميرا
    if (!this.isDragging) {
        const damping = this.options.cameraDamping || 0.08;
        this.cameraRotation.theta += (this.targetTheta - this.cameraRotation.theta) * damping;
        this.cameraRotation.phi += (this.targetPhi - this.cameraRotation.phi) * damping;
    } else {
        this.cameraRotation.theta = this.targetTheta;
        this.cameraRotation.phi = this.targetPhi;
    }

    const dist = this.options.cameraDistance;
    const height = this.options.cameraHeight;
    const theta = this.cameraRotation.theta;
    const phi = this.cameraRotation.phi;

    // حساب موقع الكاميرا الأساسي
    const baseX = dist * Math.cos(phi) * Math.sin(theta);
    const baseY = height + dist * Math.sin(phi);
    const baseZ = dist * Math.cos(phi) * Math.cos(theta);

    // ⭐ إزاحة موقع الكاميرا (cameraOffset). نظام إحداثيات مرتبط باتجاه
    // اللاعب (right/up/forward)، وليس بمحاور العالم المطلقة.
    const offset = this.options.cameraOffset || { x: 0, y: 0, z: 0 };
    const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
    const up = new THREE.Vector3(0, 1, 0);
    const forward = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));

    const lateralOffset = right.clone().multiplyScalar(offset.x || 0);
    const verticalOffset = up.clone().multiplyScalar(offset.y || 0);
    const forwardOffset = forward.clone().multiplyScalar(offset.z || 0);

    const offsetX = baseX + lateralOffset.x + verticalOffset.x + forwardOffset.x;
    const offsetY = baseY + lateralOffset.y + verticalOffset.y + forwardOffset.y;
    const offsetZ = baseZ + lateralOffset.z + verticalOffset.z + forwardOffset.z;

    // إذا كان faceCamera مفعّلاً، نضع الكاميرا خلف اللاعب مباشرة
    if (this.options.faceCamera) {
        // الكاميرا تكون دائماً خلف اللاعب
        this.camera.position.set(
            this.player.position.x + offsetX,
            this.player.position.y + offsetY,
            this.player.position.z + offsetZ
        );
    } else {
        // الوضع العادي (حركة حرة)
        this.camera.position.set(
            this.player.position.x + offsetX,
            this.player.position.y + offsetY,
            this.player.position.z + offsetZ
        );
    }

    // النظر إلى اللاعب — مع دعم lookAtOffset (إزاحة نقطة النظر بشكل مستقل
    // عن موقع الكاميرا نفسها، منقول من النسخة القديمة). يعيد استخدام نفس
    // متجهات right/up/forward المحسوبة أعلاه.
    const lookAtOffset = this.options.lookAtOffset || { x: 0, y: 0.5, z: 0 };

    const lookAtX = lookAtOffset.x || 0;
    const lookAtY = (lookAtOffset.y !== undefined) ? lookAtOffset.y : 0.5; // افتراضي: منتصف اللاعب
    const lookAtZ = lookAtOffset.z || 0;

    const lookAtLateral = right.clone().multiplyScalar(lookAtX);
    const lookAtVertical = up.clone().multiplyScalar(lookAtY);
    const lookAtForward = forward.clone().multiplyScalar(lookAtZ);

    const target = new THREE.Vector3(
        this.player.position.x + lookAtLateral.x + lookAtVertical.x + lookAtForward.x,
        this.player.position.y + lookAtLateral.y + lookAtVertical.y + lookAtForward.y,
        this.player.position.z + lookAtLateral.z + lookAtVertical.z + lookAtForward.z
    );
    this.camera.lookAt(target);
}

    jump() {
    if (!this.isActive || !this.body || !this.options.enableJump) {
        // console.log('❌ Cannot jump: inactive or no body');
        return false;
    }

    // ✅ نستخدم الآن نفس فحص الأرض الدقيق المستخدم في updatePhysics بدل
    // نسخة مستقلة بثوابت مختلفة (0.4 / 0.6) غير مرتبطة بالحجم الحقيقي
    // للاعب — كانت هذه هي السبب المباشر في تعطّل القفز أثناء الوقوف
    // الثابت على منصة (كان يعمل فقط للحظة أثناء الغرق الطفيف عند الهبوط،
    // لأن تلك اللحظة فقط كانت تقع صدفة ضمن نطاق الثوابت القديمة).
    // نضيف this.onGround كشبكة أمان إضافية (آخر حالة معروفة من updatePhysics).
    const grounded = this._checkGrounded().onGround || this.onGround;

    if (grounded) {
        this.body.wakeUp();
        this.body.velocity.y = this.options.jumpPower;
        this.onGround = false; // لمنع القفز المزدوج
        // console.log('✅ Jump!');
        return true;
    }

    // console.log('❌ Not on ground');
    return false;
}

      // تعيين إزاحة موقع الكاميرا
setCameraOffset(x, y, z) {
    this.options.cameraOffset = { x: x || 0, y: y || 0, z: z || 0 };
    this.updateCamera();
}

// إضافة إلى إزاحة موقع الكاميرا الحالية
addCameraOffset(dx, dy, dz) {
    if (this.options.cameraOffset) {
        this.options.cameraOffset.x += dx || 0;
        this.options.cameraOffset.y += dy || 0;
        this.options.cameraOffset.z += dz || 0;
    } else {
        this.options.cameraOffset = { x: dx || 0, y: dy || 0, z: dz || 0 };
    }
    this.updateCamera();
}

// الحصول على إزاحة موقع الكاميرا الحالية
getCameraOffset() {
    return this.options.cameraOffset || { x: 0, y: 0, z: 0 };
}

// إعادة تعيين إزاحة موقع الكاميرا
resetCameraOffset() {
    this.options.cameraOffset = { x: 0, y: 0, z: 0 };
    this.updateCamera();
}

      // تعيين إزاحة نقطة النظر (الهدف)
setLookAtOffset(x, y, z) {
    this.options.lookAtOffset = {
        x: x || 0,
        y: (y !== undefined) ? y : 0.5,
        z: z || 0
    };
    this.updateCamera();
}

// إضافة إلى إزاحة النظر الحالية
addLookAtOffset(dx, dy, dz) {
    if (this.options.lookAtOffset) {
        this.options.lookAtOffset.x += dx || 0;
        this.options.lookAtOffset.y += dy || 0;
        this.options.lookAtOffset.z += dz || 0;
    } else {
        this.options.lookAtOffset = { x: dx || 0, y: (dy !== undefined) ? dy : 0.5, z: dz || 0 };
    }
    this.updateCamera();
}

// الحصول على إزاحة النظر الحالية
getLookAtOffset() {
    return this.options.lookAtOffset || { x: 0, y: 0.5, z: 0 };
}

// إعادة تعيين إزاحة النظر
resetLookAtOffset() {
    this.options.lookAtOffset = { x: 0, y: 0.5, z: 0 };
    this.updateCamera();
}

    setOptions(options) {
        Object.assign(this.options, options);
    }

    destroy() {
        // إزالة عناصر الـ UI
        if (this.analogContainer && this.analogContainer.parentNode) {
            this.analogContainer.parentNode.removeChild(this.analogContainer);
        }
        if (this.cameraDragArea && this.cameraDragArea.parentNode) {
            this.cameraDragArea.parentNode.removeChild(this.cameraDragArea);
        }
        if (this.body && Html3D.physicsManager) {
    Html3D.physicsManager.removeBody(this.player);
    this.body = null;
}
        this.isActive = false;
        this.player = null;
    }
    
    // كشف التصادم مع المجسمات الأخرى
checkCollision(newPosition) {
    if (!this.player) return false;
    // ننشئ Box3 للاعب (بحجم تقريبي)
    const playerBox = new THREE.Box3().setFromObject(this.player);
    // ننقل الصندوق إلى الموقع الجديد
    const size = playerBox.getSize(new THREE.Vector3());
    const center = new THREE.Vector3(newPosition.x, newPosition.y + size.y/2, newPosition.z);
    const newBox = new THREE.Box3(center.clone().sub(size.clone().multiplyScalar(0.5)), center.clone().add(size.clone().multiplyScalar(0.5)));

    // فحص التصادم مع جميع المجسمات في المشهد (عدا اللاعب نفسه)
    const meshes = [];
    this.scene.children.forEach(child => {
        if (child.isMesh && child !== this.player) {
            // التحقق من خاصية canCollide (إذا كانت false، نتجاوزها)
            if (child.userData.canCollide === false) return;
            meshes.push(child);
        }
    });

    for (const mesh of meshes) {
        const meshBox = new THREE.Box3().setFromObject(mesh);
        if (newBox.intersectsBox(meshBox)) {
            return true; // تصادم
        }
    }
    return false;
}

// تطبيق الحركة مع كشف التصادم
applyMovement(dx, dy, dz) {
    if (!this.player) return;
    const newPos = this.player.position.clone();
    // نختبر كل محور على حدة لتحديد الاتجاه الذي يسبب التصادم
    // المحور X
    const testX = newPos.clone().add(new THREE.Vector3(dx, 0, 0));
    if (!this.checkCollision(testX)) {
        newPos.x += dx;
    }
    // المحور Y (القفز والسقوط)
    const testY = newPos.clone().add(new THREE.Vector3(0, dy, 0));
    if (!this.checkCollision(testY)) {
        newPos.y += dy;
    } else {
        // إذا كان هناك تصادم في Y، نوقف السرعة الرأسية
        this.velocity.y = 0;
        if (dy < 0) {
            this.isOnGround = true;
        }
    }
    // المحور Z
    const testZ = newPos.clone().add(new THREE.Vector3(0, 0, dz));
    if (!this.checkCollision(testZ)) {
        newPos.z += dz;
    }
    this.player.position.copy(newPos);
}
}

// ============================================================
//  10. Physics Manager (Cannon-es)
// ============================================================
class PhysicsManager {
    constructor(options = {}) {
        this.enabled = false;
        this.world = null;
        this.bodies = new Map(); // threeObject -> cannonBody
        this.meshes = new Map(); // cannonBody -> threeObject
        this.collisionCallbacks = [];
        this.gravity = options.gravity || { x: 0, y: -9.82, z: 0 };
        this.iterations = options.iterations || 10;

        if (!CANNON) {
            console.warn('PhysicsManager: Cannon.js not available.');
            return;
        }

        this.world = new CANNON.World();
        this.world.gravity.set(this.gravity.x, this.gravity.y, this.gravity.z);
        this.world.broadphase = new CANNON.SAPBroadphase(this.world);
        this.world.allowSleep = true;
        this.world.solver.iterations = this.iterations;

        const defaultMaterial = new CANNON.Material('default');
        const contactMat = new CANNON.ContactMaterial(defaultMaterial, defaultMaterial, {
            friction: 0.3,
            restitution: 0.3
        });
        this.world.addContactMaterial(contactMat);
        this.defaultMaterial = defaultMaterial;

        this.enabled = true;
        // console.log('✅ Physics enabled.');
    }

    detectShape(threeObject) {
        if (!threeObject.geometry) return 'box';
        const type = threeObject.geometry.type;
        if (type === 'BoxGeometry') return 'box';
        if (type === 'SphereGeometry') return 'sphere';
        if (type === 'CylinderGeometry') return 'cylinder';
        if (type === 'PlaneGeometry') return 'plane';
        if (type === 'ConeGeometry') return 'cylinder';
        return 'box';
    }

    addBody(threeObject, shape = null, options = {}) {
        if (!this.enabled || !this.world) {
            console.warn('Physics not enabled.');
            return null;
        }

        shape = shape || this.detectShape(threeObject);
        let cannonShape;
        const pos = threeObject.position.clone();
        const quat = threeObject.quaternion.clone();

        switch (shape) {
            case 'box': {
                const box = new THREE.Box3().setFromObject(threeObject);
                const size = box.getSize(new THREE.Vector3());
                cannonShape = new CANNON.Box(new CANNON.Vec3(size.x/2, size.y/2, size.z/2));
                break;
            }
            case 'sphere': {
                let radius = 1;
                if (threeObject.geometry && threeObject.geometry.type === 'SphereGeometry') {
                    radius = threeObject.geometry.parameters.radius || 1;
                } else {
                    const sphere = new THREE.Sphere().setFromObject(threeObject);
                    radius = sphere.radius;
                }
                cannonShape = new CANNON.Sphere(radius);
                break;
            }
            case 'cylinder': {
                let radiusTop = 1, radiusBottom = 1, height = 2;
                if (threeObject.geometry && threeObject.geometry.type === 'CylinderGeometry') {
                    const params = threeObject.geometry.parameters;
                    radiusTop = params.radiusTop || 1;
                    radiusBottom = params.radiusBottom || 1;
                    height = params.height || 2;
                }
                cannonShape = new CANNON.Cylinder(radiusTop, radiusBottom, height, 8);
                break;
            }
            case 'plane': {
    cannonShape = new CANNON.Plane();
    break;
}
            default:
                cannonShape = new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5));
        }

        const mass = options.mass !== undefined ? options.mass : (threeObject.userData.anchor === false ? 1 : 0);
        const friction = options.friction || 0.3;
        const restitution = options.restitution || 0.3;

        const body = new CANNON.Body({ mass: mass });
        body.addShape(cannonShape);
        body.position.set(pos.x, pos.y, pos.z);
        body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
        body.linearDamping = options.linearDamping || 0.01;
        body.angularDamping = options.angularDamping || 0.01;

        const mat = new CANNON.Material('custom');
        body.material = mat;

        this.world.addBody(body);
        this.bodies.set(threeObject, body);
        this.meshes.set(body, threeObject);

        if (mass === 0) {
            body.type = CANNON.Body.STATIC;
            body.updateMassProperties();
        }

        return body;
    }

    removeBody(threeObject) {
        const body = this.bodies.get(threeObject);
        if (body) {
            this.world.removeBody(body);
            this.bodies.delete(threeObject);
            this.meshes.delete(body);
        }
    }

    syncPhysics() {
    if (!this.enabled) return;
    for (const [threeObj, body] of this.bodies) {
        // ✅ الأجسام الساكنة (STATIC, mass=0) لا يحرّكها Cannon أبداً من تلقاء
        // نفسه، لذا لا داعي لنسخ body.position → threeObj.position لها كل
        // فريم — كان هذا يُلغي أي تحريك يدوي (mesh.position.set(...)) يقوم
        // به كود المستخدم فوراً في الفريم التالي، فيبدو الجسم وكأنه "لا يتحرك"
        // رغم أن position فعلياً تغيّر للحظة. الأجسام الديناميكية (mass>0)
        // فقط هي التي تحتاج هذه المزامنة (body → three) لأن الفيزياء تحرّكها.
        if (body.type === CANNON.Body.STATIC) continue;
        threeObj.position.copy(body.position);
        // ✅ إذا كان الكائن لاعباً (يحتوي على userData.isPlayer)، لا نعيد تعيين الدوران
        if (!threeObj.userData?.isPlayer) {
            threeObj.quaternion.copy(body.quaternion);
        }
    }
}

    // ✅ لتحريك كائن ساكن (STATIC) يدوياً بشكل صحيح: غيّر position/quaternion
    // على كائن three.js كالمعتاد، ثم نادِ هذه الدالة لتحديث جسم Cannon
    // المرتبط به أيضاً — وإلا سيبقى الجسم الفيزيائي (الاصطدام) في مكانه
    // القديم رغم أن الشكل المرئي انتقل (لأن Cannon لا يزامن الأجسام الساكنة
    // مع أي شيء تلقائياً، عكس الديناميكية).
    updateBodyFromObject(threeObject) {
        const body = this.bodies.get(threeObject);
        if (!body) return;
        body.position.set(threeObject.position.x, threeObject.position.y, threeObject.position.z);
        body.quaternion.set(threeObject.quaternion.x, threeObject.quaternion.y, threeObject.quaternion.z, threeObject.quaternion.w);
        body.wakeUp?.();
        if (this.world && this.world.broadphase && typeof this.world.broadphase.dirty !== 'undefined') {
            this.world.broadphase.dirty = true;
        }
    }

    applyForce(threeObject, force, worldPoint) {
        const body = this.bodies.get(threeObject);
        if (body) {
            const f = new CANNON.Vec3(force.x, force.y, force.z);
            const p = worldPoint ? new CANNON.Vec3(worldPoint.x, worldPoint.y, worldPoint.z) : body.position;
            body.applyForce(f, p);
        }
    }

    setAnchor(threeObject, isStatic) {
        const body = this.bodies.get(threeObject);
        if (body) {
            if (isStatic) {
                body.mass = 0;
                body.type = CANNON.Body.STATIC;
                body.updateMassProperties();
            } else {
                body.mass = 1;
                body.type = CANNON.Body.DYNAMIC;
                body.updateMassProperties();
            }
            threeObject.userData.anchor = isStatic;
        }
    }

    destroy() {
        this.enabled = false;
        this.bodies.clear();
        this.meshes.clear();
        this.collisionCallbacks = [];
        if (this.world) {
            // تنظيف إضافي إذا لزم
        }
    }
}

    // ============================================================
    //  7. الواجهة العامة (API) - Html3D
    // ============================================================
    class Html3D {
        static #instance = null;
        static #options = {};
        // داخل class Html3D
static css2DRenderer = null;
static css2DObjects = []; // لتتبع الكائنات

        static init(options = {}) {
            if (this.#instance) return this.#instance;

            const defaultOptions = {
                container: document.body,
                backgroundColor: 0x111122,
                camera: { fov: 45, position: [5, 5, 5] },
                controls: { enableDamping: true, enableZoom: true },
                autoStart: true,
                loadMeshesAsync: true
            };
            this.#options = { ...defaultOptions, ...options };

            // البحث عن <world>
            let worldElement = document.querySelector('world');
            if (!worldElement) {
                console.warn('Html3D: No <world> element found. Creating one...');
                worldElement = document.createElement('world');
                document.body.appendChild(worldElement);
            }

            // تهيئة المحرك
            const engine = new Engine();
            const container = this.#options.container;
            const { scene, camera, renderer } = engine.initScene(container, {
                backgroundColor: this.#options.backgroundColor,
                fov: this.#options.camera.fov
            });

            // تعيين موقع الكاميرا
            const [px, py, pz] = this.#options.camera.position;
            camera.position.set(px, py, pz);
            camera.lookAt(0, 0, 0);
            
            // ✅ تفعيل الفيزياء تلقائياً
if (!this.physicsManager && typeof CANNON !== 'undefined') {
    this.physicsManager = new PhysicsManager(this.#options.physics || {});
}

            // تهيئة OrbitControls (إذا وجدت)
            // في دالة init()، بعد إنشاء renderer
let controls = null;
const OrbitControls = global.OrbitControls || global.THREE?.OrbitControls;
if (OrbitControls) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = this.#options.controls.enableDamping || true;
    controls.enableZoom = this.#options.controls.enableZoom || true;
    controls.update();
} else {
    console.warn('Html3D: OrbitControls not found. Camera controls will not work.');
    console.warn('Please include OrbitControls.js or use importmap.');
}

            // تهيئة ScadParser
            const scadParser = new ScadParser();

            // تهيئة DOM Parser
            const parser = new HtmlDomParser(engine, scadParser);
            parser.setScene(scene);

            // تحليل <world>
            // تحليل <world>
if (worldElement) {
    // console.log('🔍 تحليل <world>...');
    parser.parse(worldElement);
    // console.log('✅ تم تحليل <world>');
} else {
    console.warn('⚠️ لا يوجد عنصر <world>');
}

// ✅ تحقق من وجود الكائنات بعد التحليل
// console.log(`📊 بعد التحليل: ${scene.children.length} كائنات`);

            // تهيئة CSS Handler
            const cssHandler = new CssHandler(parser);

            // تهيئة Event Binder
            const eventBinder = new EventBinder(renderer, camera, scene, parser);

this.initCSS2DRenderer();
          
            // بدء حلقة العرض
            if (this.#options.autoStart) {
                this.#startRenderLoop(renderer, scene, camera, controls);
            }

            // حفظ المراجع
            this.#instance = {
                scene,
                camera,
                renderer,
                controls,
                engine,
                scadParser,
                parser,
                cssHandler,
                eventBinder,
                worldElement,
                options: this.#options
            };

            // console.log('Html3D: Initialized successfully!');

            // تحميل الـ meshes بشكل غير متزامن
            if (this.#options.loadMeshesAsync) {
                this.#loadMeshesAsync(worldElement, parser);
            }

            return this.#instance;
        }

        static #startRenderLoop(renderer, scene, camera, controls) {
    let lastTime = 0;
    function animate(time) {
        requestAnimationFrame(animate);
        const delta = lastTime ? (time - lastTime) / 1000 : 0.016;
        lastTime = time;
        
        // ✅ تحديث الفيزياء
if (Html3D.physicsManager && Html3D.physicsManager.enabled) {
    Html3D.physicsManager.world.step(1/60, delta, 3);
    Html3D.physicsManager.syncPhysics();
}

        // تحديث الفيزياء والكاميرا
        if (Html3D.playerController && Html3D.playerController.isActive) {
            Html3D.playerController.updatePhysics(delta);
            // تحديث الكاميرا مرة أخرى للتأكد
            Html3D.playerController.updateCamera();
        }

        // تحديث controls فقط إذا كان اللاعب غير نشط
        if (controls && !Html3D.playerController?.isActive) {
            controls.update();
        }

    Html3D.updateLabelsVisibility(camera);

        // ✅ تحديث الحركات (Animations) والتأثيرات (Effects) النشطة في المشهد
        if (globalAnimationRegistry) {
            globalAnimationRegistry.update(delta);
        } else {
            warnFeatureOnce('animation-system', 'animation-system.js unavailable — skipping animation updates.');
        }
        if (globalEffectRegistry) {
            globalEffectRegistry.update(delta);
        } else {
            warnFeatureOnce('effects-system', 'effects-system.js unavailable — skipping effect updates.');
        }

        renderer.render(scene, camera);

      // داخل animate() بعد renderer.render(...)
if (Html3D.css2DRenderer) {
    Html3D.css2DRenderer.render(scene, camera);
}
    }
    animate(0);
}

        static async #loadMeshesAsync(worldElement, parser) {
            const meshes = worldElement.querySelectorAll('mesh[src]');
            for (const mesh of meshes) {
                try {
                    await parser.loadMeshAsync(mesh);
                } catch (error) {
                    console.error('Error loading mesh:', error);
                }
            }
            // console.log('Html3D: All meshes loaded.');
        }

        static update() {
            if (!this.#instance) {
                console.warn('Html3D: Not initialized. Call init() first.');
                return;
            }
            const worldElement = document.querySelector('world');
            if (worldElement && this.#instance.parser) {
                this.#instance.parser.parse(worldElement);
            }
        }

        static getScene() {
            return this.#instance?.scene || null;
        }

        static getCamera() {
            return this.#instance?.camera || null;
        }

        static getRenderer() {
            return this.#instance?.renderer || null;
        }

        static getControls() {
            return this.#instance?.controls || null;
        }

        static getThreeObject(domElement) {
            if (!this.#instance) return null;
            return this.#instance.parser?.elementMap?.get(domElement) || null;
        }

        static getDomElement(threeObject) {
            if (!threeObject) return null;
            return threeObject.userData?.domElement || null;
        }

        static getWorldElement() {
            return this.#instance?.worldElement || null;
        }
        
        // داخل class Html3D
static playerController = null;

static setPlayer(object, options = {}, faceCamera = undefined, cameraOffset = null, lookAtOffset = null) {
    if (!this.#instance) {
        console.error('Html3D: Must call init() before setPlayer().');
        return;
    }
    if (!this.playerController) {
        const { scene, camera, renderer } = this.#instance;
        this.playerController = new PlayerController(scene, camera, renderer);
    }

    // ✅ نأخذ faceCamera من الوسيط المنفصل فقط إن مُرِّر صراحة، وإلا نحافظ
    // على القيمة الموجودة داخل options.faceCamera (إن وُجدت). سابقاً كان
    // هذا الوسيط يُستخدم دائماً (بقيمته الافتراضية false) فيُلغي أي قيمة
    // true وُضعت داخل options عن طريق الخطأ — وهذا كان سبب عدم دوران
    // اللاعب نحو اتجاه الكاميرا رغم تفعيل faceCamera.
    const resolvedFaceCamera = (faceCamera !== undefined) ? faceCamera : !!options.faceCamera;
    const mergedOptions = { ...options, faceCamera: resolvedFaceCamera };
    if (cameraOffset) {
        mergedOptions.cameraOffset = { x: cameraOffset.x || 0, y: cameraOffset.y || 0, z: cameraOffset.z || 0 };
    }
    if (lookAtOffset) {
        mergedOptions.lookAtOffset = {
            x: lookAtOffset.x || 0,
            y: (lookAtOffset.y !== undefined) ? lookAtOffset.y : 0.5,
            z: lookAtOffset.z || 0
        };
    }
    this.playerController.setPlayer(object, mergedOptions, resolvedFaceCamera);
    
    // إظهار العصا
    if (this.playerController.analogContainer) {
        this.playerController.analogContainer.style.display = 'flex';
    }
    if (this.playerController.cameraDragArea) {
        this.playerController.cameraDragArea.style.pointerEvents = 'auto';
    }
    
    // تعطيل OrbitControls
    if (this.#instance.controls) {
        this.#instance.controls.enabled = false;
    }
}

static getPlayer() {
    if (!this.playerController) return null;
    return this.playerController.player;
}

static togglePerspective(mode) {
    if (!this.playerController) {
        console.warn('Html3D: No player set.');
        return;
    }
    this.playerController.togglePerspective(mode);
}

static playerJump() {
    if (this.playerController) {
        this.playerController.jump();
    }
}

      // تعيين إزاحة الكاميرا
static setCameraOffset(x, y, z) {
    if (!this.playerController) {
        console.warn('Html3D: No player controller. Call setPlayer() first.');
        return false;
    }
    this.playerController.setCameraOffset(x, y, z);
    return true;
}

// إضافة إلى إزاحة الكاميرا
static addCameraOffset(dx, dy, dz) {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return false;
    }
    this.playerController.addCameraOffset(dx, dy, dz);
    return true;
}

// الحصول على إزاحة الكاميرا
static getCameraOffset() {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return null;
    }
    return this.playerController.getCameraOffset();
}

// إعادة تعيين إزاحة الكاميرا
static resetCameraOffset() {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return false;
    }
    this.playerController.resetCameraOffset();
    return true;
}


      // تعيين إزاحة نقطة النظر
static setLookAtOffset(x, y, z) {
    if (!this.playerController) {
        console.warn('Html3D: No player controller. Call setPlayer() first.');
        return false;
    }
    this.playerController.setLookAtOffset(x, y, z);
    return true;
}

// إضافة إلى إزاحة النظر
static addLookAtOffset(dx, dy, dz) {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return false;
    }
    this.playerController.addLookAtOffset(dx, dy, dz);
    return true;
}

// الحصول على إزاحة النظر
static getLookAtOffset() {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return null;
    }
    return this.playerController.getLookAtOffset();
}

// إعادة تعيين إزاحة النظر
static resetLookAtOffset() {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return false;
    }
    this.playerController.resetLookAtOffset();
    return true;
}

      // تعيين FOV مباشر
static setFOV(fov) {
    if (!this.#instance || !this.#instance.camera) {
        console.warn('Html3D: Camera not initialized.');
        return false;
    }
    this.#instance.camera.fov = fov;
    this.#instance.camera.updateProjectionMatrix();
    return true;
}

// الحصول على FOV الحالي
static getFOV() {
    if (!this.#instance || !this.#instance.camera) {
        console.warn('Html3D: Camera not initialized.');
        return null;
    }
    return this.#instance.camera.fov;
}

// تغيير FOV مع تأثير سلس (لللاعب فقط)
static setPlayerFOV(fov, duration = 500) {
    if (!this.playerController) {
        console.warn('Html3D: No player controller.');
        return false;
    }
    this.playerController.setFOVSmooth(fov, duration);
    return true;
}

static setPlayerOptions(options) {
    if (this.playerController) {
        this.playerController.setOptions(options);
    }
}

static removePlayer() {
    if (this.playerController) {
        this.playerController.destroy();
        this.playerController = null;
        // إعادة تمكين OrbitControls
        if (this.#instance && this.#instance.controls) {
            this.#instance.controls.enabled = true;
        }
    }
}

// ===== دوال الفيزياء العامة =====
static getPhysicsWorld() {
    return this.physicsManager?.world || null;
}

static applyForce(threeObject, force, worldPoint) {
    if (this.physicsManager) {
        this.physicsManager.applyForce(threeObject, force, worldPoint);
    }
}

static setAnchor(threeObject, isStatic) {
    if (this.physicsManager) {
        this.physicsManager.setAnchor(threeObject, isStatic);
        threeObject.userData.anchor = isStatic;
    }
}

static syncPhysics() {
    if (this.physicsManager) {
        this.physicsManager.syncPhysics();
    }
}


      // داخل class Html3D
static css2DRenderer = null;

static initCSS2DRenderer(scene, camera) {
    if (this.css2DRenderer) return this.css2DRenderer;
    
    // لا تتحقق من #instance
    
    if (!CSS2DRenderer) {
        warnFeatureOnce('css2d-renderer', 'CSS2DRenderer unavailable — HTML labels will not be rendered.');
        return null;
    }
    
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    labelRenderer.domElement.style.left = '0px';
    labelRenderer.domElement.style.pointerEvents = 'none';
    labelRenderer.domElement.style.zIndex = '10';
    document.body.appendChild(labelRenderer.domElement);
    
    this.css2DRenderer = labelRenderer;
    // console.log('✅ CSS2DRenderer initialized');
    return labelRenderer;
}

// داخل class Html3D
static interactiveLabels = new Map(); // لتتبع التسميات التفاعلية

static createLabel(htmlContent, position = {x:0, y:0, z:0}, options = {}) {
    const div = document.createElement('div');
    if (typeof htmlContent === 'string') {
        div.innerHTML = htmlContent;
    } else if (htmlContent instanceof HTMLElement) {
        div.appendChild(htmlContent);
    }
    
    // تطبيق الإعدادات
    if (options.className) div.className = options.className;
    if (options.style) Object.assign(div.style, options.style);

  const maxDistance = options.maxDistance !== undefined ? options.maxDistance : -1;
    
    // ✅ جعل العنصر قابل للتفاعل إذا كان interactive: true
    if (options.interactive) {
        div.style.pointerEvents = 'auto'; // السماح بالنقر
        div.style.cursor = 'pointer'; // تغيير المؤشر
        
        // إضافة مستمعي الأحداث
        if (options.onClick) {
            div.addEventListener('click', options.onClick);
        }
        if (options.onMouseEnter) {
            div.addEventListener('mouseenter', options.onMouseEnter);
        }
        if (options.onMouseLeave) {
            div.addEventListener('mouseleave', options.onMouseLeave);
        }
        if (options.onTouchStart) {
            div.addEventListener('touchstart', options.onTouchStart);
        }
    } else {
        div.style.pointerEvents = 'none';
    }
  let label;
    if (CSS2DObject) {
     label = new CSS2DObject(div);
    label.position.set(position.x, position.y, position.z);
    
    if (options.scale) {
        label.scale.set(options.scale, options.scale, options.scale);
    }
    
    // تخزين البيانات
    label.userData.interactive = options.interactive || false;
    label.userData.labelId = options.id || 'label-' + Date.now();
  label.userData.maxDistance = maxDistance;
    } else {
        warnFeatureOnce('css2d-label', 'CSS2DObject unavailable — programmatic label creation is skipped.');
    }
    return label;
}

// ✅ دالة لإضافة زر تفاعلي
static createButton(text, position, onClick, options = {}) {
    const buttonHTML = `<button style="
        background: ${options.bgColor || '#3498db'};
        color: ${options.textColor || 'white'};
        border: none;
        padding: ${options.padding || '10px 20px'};
        border-radius: ${options.borderRadius || '8px'};
        font-size: ${options.fontSize || '16px'};
        font-weight: bold;
        cursor: pointer;
        box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        transition: all 0.2s;
        border: 2px solid ${options.borderColor || 'transparent'};
    ">${text}</button>`;
    
    return this.createLabel(buttonHTML, position, {
        interactive: true,
        className: options.className || 'interactive-btn',
        style: options.style || {},
        scale: options.scale || 1,
        onClick: onClick,
        onMouseEnter: options.onMouseEnter || ((e) => {
            e.target.style.transform = 'scale(1.05)';
            e.target.style.boxShadow = '0 6px 12px rgba(0,0,0,0.4)';
        }),
        onMouseLeave: options.onMouseLeave || ((e) => {
            e.target.style.transform = 'scale(1)';
            e.target.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
        })
    });
}

static addLabelToScene(label) {
    const scene = this.getScene();
    if (scene && label) {
        scene.add(label);
        return label;
    }
    return null;
}

static attachLabelToObject(label, object3D, offset = {x:0, y:0, z:0}) {
    // إضافة label كابن للكائن object3D
    if (object3D && label) {
        object3D.add(label);
        label.position.set(offset.x, offset.y, offset.z);
        return label;
    }
    return null;
}

// ===== تحديث رؤية التسميات حسب المسافة =====
static updateLabelsVisibility(camera) {
    const scene = this.getScene();
    if (!scene) return;
    
    // البحث عن جميع التسميات في المشهد
    const labels = [];
    scene.traverse((child) => {
        if (child.isCSS2DObject && child.userData.isLabel) {
            labels.push(child);
        }
    });
    
    // تحديث رؤية كل تسمية
    for (const label of labels) {
        const maxDistance = label.userData.maxDistance;
        
        // إذا كانت maxDistance = -1 (لانهائية)، اجعلها مرئية دائماً
        if (maxDistance === -1 || maxDistance === undefined) {
            label.visible = true;
            continue;
        }
        
        // حساب المسافة بين الكاميرا والتسمية
        const distance = camera.position.distanceTo(label.position);
        
        // إظهار أو إخفاء التسمية حسب المسافة
        if (distance > maxDistance) {
            label.visible = false;
        } else {
            label.visible = true;
        }
    }
}

      // ============================================================
//  دوال التحكم في التسميات (Labels)
// ============================================================

// تغيير موقع التسمية
static setLabelPosition(label, x, y, z) {
    if (label && label.isCSS2DObject) {
        label.position.set(x, y, z);
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير المسافة القصوى للتسمية
static setLabelMaxDistance(label, distance) {
    if (label && label.isCSS2DObject && label.userData.isLabel) {
        label.userData.maxDistance = distance;
        // تحديث الرؤية فوراً
        const camera = this.getCamera();
        if (camera) {
            this.updateLabelsVisibility(camera);
        }
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير حجم التسمية (scale)
static setLabelScale(label, scale) {
    if (label && label.isCSS2DObject) {
        label.scale.set(scale, scale, 1);
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير محتوى التسمية (HTML)
static setLabelHTML(label, html) {
    if (label && label.isCSS2DObject && label.element) {
        label.element.innerHTML = html;
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير نص التسمية (نص عادي)
static setLabelText(label, text) {
    if (label && label.isCSS2DObject && label.element) {
        label.element.textContent = text;
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// إظهار أو إخفاء التسمية
static setLabelVisible(label, visible) {
    if (label && label.isCSS2DObject) {
        label.visible = visible;
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير لون التسمية (CSS)
static setLabelColor(label, color) {
    if (label && label.isCSS2DObject && label.element) {
        label.element.style.color = color;
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير خلفية التسمية (CSS)
static setLabelBackground(label, bg) {
    if (label && label.isCSS2DObject && label.element) {
        label.element.style.background = bg;
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تغيير border التسمية (CSS)
static setLabelBorder(label, border) {
    if (label && label.isCSS2DObject && label.element) {
        label.element.style.border = border;
        return true;
    }
    console.warn('Html3D: Invalid label object');
    return false;
}

// تطبيق إعدادات متعددة على التسمية دفعة واحدة
static updateLabel(label, settings) {
    if (!label || !label.isCSS2DObject) {
        console.warn('Html3D: Invalid label object');
        return false;
    }
    
    if (settings.position) {
        label.position.set(settings.position.x, settings.position.y, settings.position.z);
    }
    if (settings.maxDistance !== undefined) {
        label.userData.maxDistance = settings.maxDistance;
    }
    if (settings.scale) {
        label.scale.set(settings.scale, settings.scale, 1);
    }
    if (settings.html) {
        label.element.innerHTML = settings.html;
    }
    if (settings.text) {
        label.element.textContent = settings.text;
    }
    if (settings.visible !== undefined) {
        label.visible = settings.visible;
    }
    if (settings.color) {
        label.element.style.color = settings.color;
    }
    if (settings.background) {
        label.element.style.background = settings.background;
    }
    if (settings.border) {
        label.element.style.border = settings.border;
    }
    if (settings.fontSize) {
        label.element.style.fontSize = settings.fontSize;
    }
    if (settings.padding) {
        label.element.style.padding = settings.padding;
    }
    
    // تحديث الرؤية إذا تغيرت المسافة
    if (settings.maxDistance !== undefined) {
        const camera = this.getCamera();
        if (camera) {
            this.updateLabelsVisibility(camera);
        }
    }
    
    return true;
}

// البحث عن تسمية بواسطة id
static findLabelById(id) {
    const scene = this.getScene();
    if (!scene) return null;
    
    let result = null;
    scene.traverse((child) => {
        if (child.isCSS2DObject && child.userData.isLabel) {
            if (child.userData.labelId === id) {
                result = child;
            }
        }
    });
    return result;
}

// البحث عن تسميات بواسطة class
static findLabelsByClass(className) {
    const scene = this.getScene();
    if (!scene) return [];
    
    const results = [];
    scene.traverse((child) => {
        if (child.isCSS2DObject && child.userData.isLabel) {
            if (child.userData.labelClass === className) {
                results.push(child);
            }
        }
    });
    return results;
}

// الحصول على جميع التسميات في المشهد
static getAllLabels() {
    const scene = this.getScene();
    if (!scene) return [];
    
    const results = [];
    scene.traverse((child) => {
        if (child.isCSS2DObject && child.userData.isLabel) {
            results.push(child);
        }
    });
    return results;
}
      // ===== تحديث التسمية من CSS =====
static updateLabelFromCSS(label) {
    if (!label || !label.userData.sourceElement) return false;
    
    const element = label.userData.sourceElement;
    const computed = getComputedStyle(element);
    
    // قراءة الخصائص المخصصة
    const maxDistance = parseFloat(computed.getPropertyValue('--max-distance')) || -1;
    const scale = parseFloat(computed.getPropertyValue('--scale')) || 1;
    const opacity = parseFloat(computed.getPropertyValue('opacity')) || 1;
    const visibility = computed.getPropertyValue('visibility') !== 'hidden';
    
    // تطبيق الخصائص
    label.userData.maxDistance = maxDistance;
    label.scale.set(scale, scale, 1);
    label.visible = visibility;
    label.element.style.opacity = opacity;
    
    // تحديث الرؤية
    const camera = this.getCamera();
    if (camera) {
        this.updateLabelsVisibility(camera);
    }
    
    return true;
}

// ===== تحديث جميع التسميات من CSS =====
static updateAllLabelsFromCSS() {
    const labels = this.getAllLabels();
    for (const label of labels) {
        this.updateLabelFromCSS(label);
    }
}

static pathfinder = null;
static pathfinderGrid = null;
static pathfinderInstance = null;

static initPathfinding(width = 20, depth = 20, cellSize = 0.5, yLevel = 0) {
    const scene = this.getScene();
    if (!scene) {
        console.error('Html3D: Scene not initialized. Call init() first.');
        return null;
    }

    this.pathfinderGrid = new PathfindingGrid(width, depth, cellSize, yLevel, scene, this.physicsManager);
    
    // ✅ إضافة هذا الشرط لتجنب الخطأ
    if (this.physicsManager && this.physicsManager.enabled) {
        this.pathfinderGrid.updateWalkable(scene, this.physicsManager);
    } else {
        console.warn('Physics not enabled, using fallback walkable check.');
        this.pathfinderGrid.updateWalkable(scene, null);
    }
    
    this.pathfinderInstance = new AStarPathfinder(this.pathfinderGrid);
    
    // console.log('✅ Pathfinding system initialized.');
    return this.pathfinderInstance;
}

static findPath(startPos, goalPos) {
    if (!this.pathfinderInstance) {
        console.warn('Html3D: Pathfinding not initialized. Call initPathfinding() first.');
        return null;
    }
    return this.pathfinderInstance.findPath(startPos, goalPos);
}

static moveTo(object, targetPos, speed = 2, onComplete = null, onProgress = null) {
    if (!this.pathfinderInstance) {
        console.warn('Html3D: Pathfinding not initialized.');
        return null;
    }
    return this.pathfinderInstance.moveTo(object, targetPos, speed, onComplete, onProgress);
}

static updatePathfindingGrid() {
    if (this.pathfinderGrid) {
        this.pathfinderGrid.updateWalkable(this.getScene(), this.physicsManager);
    }
}

static getPathfindingGrid() {
    return this.pathfinderGrid;
}

static visualizeGrid() {
    const grid = this.getPathfindingGrid();
    if (!grid) return null;
    
    const scene = this.getScene();
    if (!scene) return null;
    
    // إزالة التصورات القديمة
    const oldVisuals = [];
    scene.traverse((child) => {
        if (child.userData && child.userData.isPathVisualization) {
            oldVisuals.push(child);
        }
    });
    oldVisuals.forEach(v => scene.remove(v));
    
    // إنشاء تصور جديد
    const materialWalkable = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.1, side: THREE.DoubleSide });
    const materialBlocked = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
    const geometry = new THREE.PlaneGeometry(grid.cellSize * 0.9, grid.cellSize * 0.9);
    
    for (let x = 0; x < grid.width; x++) {
        for (let z = 0; z < grid.depth; z++) {
            const node = grid.nodes[x][z];
            const mesh = new THREE.Mesh(geometry, node.walkable ? materialWalkable : materialBlocked);
            mesh.position.copy(node.worldPos);
            mesh.rotation.x = -Math.PI / 2;
            mesh.userData.isPathVisualization = true;
            scene.add(mesh);
        }
    }
    
    return true;
}

      
    } // END OF HTML3D CLASS


// ============================================================
//  11. Pathfinding System (نظام البحث عن المسار)
// ============================================================

class PathfindingNode {
    constructor(x, z, worldPos) {
        this.x = x;
        this.z = z;
        this.worldPos = worldPos;
        this.walkable = true;
        this.neighbors = [];
        this.g = 0;
        this.h = 0;
        this.f = 0;
        this.parent = null;
        this.obstacle = null; // مرجع للعائق إذا كان موجوداً
    }
}

class PathfindingGrid {
    constructor(width, depth, cellSize, yLevel = 0, scene = null, physicsManager = null) {
        this.cellSize = cellSize;
        this.width = width;
        this.depth = depth;
        this.yLevel = yLevel;
        this.scene = scene;
        this.physicsManager = physicsManager;
        this.nodes = [];
        this.obstacles = new Set();
        this.buildGrid();
    }

    buildGrid() {
        const offsetX = (this.width * this.cellSize) / 2;
        const offsetZ = (this.depth * this.cellSize) / 2;
        
        for (let x = 0; x < this.width; x++) {
            this.nodes[x] = [];
            for (let z = 0; z < this.depth; z++) {
                const pos = new THREE.Vector3(
                    x * this.cellSize - offsetX + this.cellSize/2,
                    this.yLevel,
                    z * this.cellSize - offsetZ + this.cellSize/2
                );
                this.nodes[x][z] = new PathfindingNode(x, z, pos);
            }
        }
        
        // ربط الجيران (8 اتجاهات)
        for (let x = 0; x < this.width; x++) {
            for (let z = 0; z < this.depth; z++) {
                const node = this.nodes[x][z];
                const dirs = [
                    [-1, -1], [-1, 0], [-1, 1],
                    [0, -1],           [0, 1],
                    [1, -1],  [1, 0],  [1, 1]
                ];
                for (const [dx, dz] of dirs) {
                    const nx = x + dx, nz = z + dz;
                    if (nx >= 0 && nx < this.width && nz >= 0 && nz < this.depth) {
                        node.neighbors.push(this.nodes[nx][nz]);
                    }
                }
            }
        }
    }

    getClosestNode(position) {
    if (!this.nodes || this.nodes.length === 0) {
        console.warn('PathfindingGrid: Grid not built yet.');
        return null;
    }
    
    let closest = null;
    let minDist = Infinity;
    
    for (let x = 0; x < this.width; x++) {
        if (!this.nodes[x]) continue;
        for (let z = 0; z < this.depth; z++) {
            const node = this.nodes[x][z];
            if (!node) continue;
            const dist = node.worldPos.distanceTo(position);
            if (dist < minDist) {
                minDist = dist;
                closest = node;
            }
        }
    }
    return closest;
}

    updateWalkable(scene, physicsManager) {
        this.scene = scene || this.scene;
        this.physicsManager = physicsManager || this.physicsManager;
        
        if (!this.scene) {
            console.warn('PathfindingGrid: No scene provided for walkable update.');
            return;
        }

        const raycaster = new THREE.Raycaster();
        const origin = new THREE.Vector3();
        const direction = new THREE.Vector3(0, -1, 0);
        
        // جمع كل الأجسام التي يمكن أن تكون عوائق
        // جمع العوائق (تجاهل الأرضيات واللاعب والنقاط الصغيرة)
const obstacles = [];
this.scene.traverse((child) => {
    if (child.isMesh) {
        // تجاهل الأرضيات
        if (child.userData.isGround) return;
        // تجاهل اللاعب
        if (child.userData.isPlayer) return;
        // تجاهل الكرات الصغيرة (نقاط البداية والنهاية)
        if (child.geometry.type === 'SphereGeometry' && child.geometry.parameters.radius < 0.5) return;
        obstacles.push(child);
    }
});


        for (let x = 0; x < this.width; x++) {
            for (let z = 0; z < this.depth; z++) {
                const node = this.nodes[x][z];
                const pos = node.worldPos.clone();
                pos.y = 10; // ارتفاع البداية للشعاع
                
                raycaster.set(pos, direction);
                const intersects = raycaster.intersectObjects(obstacles, false);
                
                let blocked = false;
                for (const intersect of intersects) {
                    // إذا كان التقاطع قريباً من مستوى الأرض (يعني يوجد عائق)
                    if (intersect.distance < 12 && intersect.distance > 0.1) {
                        // تجاهل الأرضية إذا كانت موجودة
                        if (intersect.object.userData.isGround) continue;
                        blocked = true;
                        node.obstacle = intersect.object;
                        break;
                    }
                }
                
                node.walkable = !blocked;
            }
        }
    }

    // إضافة عائق يدوياً
    addObstacle(mesh) {
        this.obstacles.add(mesh);
        mesh.userData.isPathfindingObstacle = true;
        this.updateWalkable();
    }

    removeObstacle(mesh) {
        this.obstacles.delete(mesh);
        mesh.userData.isPathfindingObstacle = false;
        this.updateWalkable();
    }

    // تصدير الشبكة كصورة (للت debugging)
    exportGridImage() {
        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.depth;
        const ctx = canvas.getContext('2d');
        
        for (let x = 0; x < this.width; x++) {
            for (let z = 0; z < this.depth; z++) {
                const node = this.nodes[x][z];
                ctx.fillStyle = node.walkable ? '#00ff00' : '#ff0000';
                ctx.fillRect(x, z, 1, 1);
            }
        }
        return canvas;
    }
}

// ============================================================
//  12. A* Pathfinding Algorithm
// ============================================================

class AStarPathfinder {
    constructor(grid) {
        this.grid = grid;
    }

    heuristic(a, b) {
        // مسافة مانهاتن (أو إقليدية)
        return Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
        // return a.worldPos.distanceTo(b.worldPos);
    }

    getNeighbors(node) {
        return node.neighbors;
    }
  // داخل class AStarPathfinder
findNearestWalkable(node) {
    if (!node) return null;
    if (node.walkable) return node;
    
    // بحث BFS عن أقرب عقدة مسموحة
    const queue = [node];
    const visited = new Set();
    visited.add(node);
    
    while (queue.length > 0) {
        const current = queue.shift();
        for (const neighbor of current.neighbors) {
            if (visited.has(neighbor)) continue;
            visited.add(neighbor);
            if (neighbor.walkable) {
                return neighbor;
            }
            queue.push(neighbor);
        }
    }
    return null;
}

    findPath(startPos, goalPos, maxIterations = 10000) {
        
    if (!this.grid) {
        console.warn('AStarPathfinder: Grid not set.');
        return null;
    }

    // ✅ تحقق من وجود this.grid.nodes
    if (!this.grid.nodes || this.grid.nodes.length === 0) {
        console.warn('AStarPathfinder: Grid has no nodes.');
        return null;
    }

    this.grid.updateWalkable();

    let startNode = this.grid.getClosestNode(startPos);
    let goalNode = this.grid.getClosestNode(goalPos);

    if (!startNode || !goalNode) {
        console.warn('AStarPathfinder: Start or goal node not found.');
        return null;
    }

    // ✅ إذا كانت العقدة الابتدائية محجوبة، ابحث عن أقرب عقدة مسموحة
    if (!startNode.walkable) {
        console.warn('AStarPathfinder: Start node is blocked, searching for nearest walkable node...');
        startNode = this.findNearestWalkable(startNode);
        if (!startNode) {
            console.warn('AStarPathfinder: No walkable start node found.');
            return null;
        }
    }

    if (!goalNode.walkable) {
        console.warn('AStarPathfinder: Goal node is blocked, searching for nearest walkable node...');
        goalNode = this.findNearestWalkable(goalNode);
        if (!goalNode) {
            console.warn('AStarPathfinder: No walkable goal node found.');
            return null;
        }
    }

    

        const openSet = [];
        const closedSet = new Set();
        const nodeMap = new Map();

        // إعادة تعيين العقد
        for (let x = 0; x < this.grid.width; x++) {
            for (let z = 0; z < this.grid.depth; z++) {
                const node = this.grid.nodes[x][z];
                node.g = 0;
                node.h = 0;
                node.f = 0;
                node.parent = null;
            }
        }

        startNode.g = 0;
        startNode.h = this.heuristic(startNode, goalNode);
        startNode.f = startNode.h;
        openSet.push(startNode);
        nodeMap.set(startNode, true);

        let iterations = 0;

        while (openSet.length > 0 && iterations < maxIterations) {
            iterations++;
            
            // ترتيب openSet حسب f
            openSet.sort((a, b) => a.f - b.f);
            const current = openSet.shift();
            nodeMap.delete(current);

            if (current === goalNode) {
                return this.reconstructPath(current);
            }

            closedSet.add(current);

            for (const neighbor of this.getNeighbors(current)) {
                if (closedSet.has(neighbor)) continue;
                if (!neighbor.walkable) continue;

                // حساب التكلفة (مع مراعاة الاتجاه القطري)
                const isDiagonal = (current.x !== neighbor.x && current.z !== neighbor.z);
                const moveCost = isDiagonal ? 1.414 : 1.0;
                const tentativeG = current.g + moveCost;

                if (!nodeMap.has(neighbor) || tentativeG < neighbor.g) {
                    neighbor.parent = current;
                    neighbor.g = tentativeG;
                    neighbor.h = this.heuristic(neighbor, goalNode);
                    neighbor.f = neighbor.g + neighbor.h;
                    
                    if (!nodeMap.has(neighbor)) {
                        openSet.push(neighbor);
                        nodeMap.set(neighbor, true);
                    }
                }
            }
        }

        console.warn('AStarPathfinder: No path found.');
        return null;
    }

    reconstructPath(node) {
        const path = [];
        let current = node;
        
        while (current) {
            path.push(current.worldPos.clone());
            current = current.parent;
        }
        
        return path.reverse();
    }

    // تنعيم المسار (اختياري)
    smoothPath(path, iterations = 5) {
        if (!path || path.length < 3) return path;
        
        let smoothed = path.slice();
        for (let iter = 0; iter < iterations; iter++) {
            const newPath = [smoothed[0]];
            for (let i = 1; i < smoothed.length - 1; i++) {
                const prev = smoothed[i-1];
                const curr = smoothed[i];
                const next = smoothed[i+1];
                
                // إذا كان الاتجاه مستقيم، يمكن حذف النقطة
                const vec1 = new THREE.Vector3().copy(curr).sub(prev);
                const vec2 = new THREE.Vector3().copy(next).sub(curr);
                vec1.y = 0;
                vec2.y = 0;
                vec1.normalize();
                vec2.normalize();
                
                const dot = vec1.dot(vec2);
                if (dot > 0.95) {
                    // نقطة على خط مستقيم، تخطيها
                    continue;
                }
                newPath.push(curr);
            }
            newPath.push(smoothed[smoothed.length - 1]);
            smoothed = newPath;
        }
        return smoothed;
    }

    // تتبع المسار
    followPath(object, path, speed = 2, onComplete = null, onProgress = null) {
        if (!path || path.length === 0) {
            if (onComplete) onComplete();
            return;
        }

        let index = 0;
        let isMoving = true;
        const stepSize = speed * 0.016; // لكل إطار (تقريباً 60fps)

        const moveStep = () => {
            if (!isMoving || index >= path.length) {
                if (onComplete) onComplete();
                return;
            }

            const target = path[index];
            const direction = new THREE.Vector3().copy(target).sub(object.position);
            direction.y = 0;
            const distance = direction.length();

            if (distance < 0.05) {
                index++;
                if (onProgress) onProgress(index / path.length);
                moveStep();
                return;
            }

            if (distance < stepSize) {
                object.position.copy(target);
                index++;
                if (onProgress) onProgress(index / path.length);
                moveStep();
                return;
            }

            direction.normalize();
            object.position.add(direction.multiplyScalar(stepSize));
            
            // تدوير الكائن في اتجاه الحركة
            if (direction.length() > 0.01) {
                const angle = Math.atan2(direction.x, direction.z);
                object.rotation.y = angle;
            }

            if (onProgress) onProgress(index / path.length);
            requestAnimationFrame(moveStep);
        };

        moveStep();

        // إرجاع دالة لإيقاف الحركة
        return () => {
            isMoving = false;
        };
    }

    // العثور على مسار وتتبعه دفعة واحدة
    moveTo(object, targetPos, speed = 2, onComplete = null, onProgress = null) {
        const path = this.findPath(object.position, targetPos);
        if (!path) {
            console.warn('AStarPathfinder: Cannot find path to target.');
            if (onComplete) onComplete(false);
            return null;
        }
        
        // تنعيم المسار
        const smoothedPath = this.smoothPath(path);
        
        return this.followPath(object, smoothedPath, speed, () => {
            if (onComplete) onComplete(true);
        }, onProgress);
    }
}

// ============================================================
//  13. دمج النظام مع Html3D
// ============================================================

// أضف هذه الدوال إلى class Html3D


  
    // ============================================================
    //  8. تصدير المكتبة
    // ============================================================
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = Html3D;
    }
    if (typeof window !== 'undefined') {
        window.Html3D = Html3D;
    }
    if (typeof global !== 'undefined') {
        global.Html3D = Html3D;
        // جسر مؤقت لتصدير ScadParser خارج الـ IIFE كـ ES module حقيقي
        // (انظر سطر "export const ScadParser" في نهاية الملف تماماً)
        global.__Html3D_ScadParser = ScadParser;
        // ✅ HtmlDomParser مطلوب أيضاً لوضع World (تحليل عناصر <world> إلى مشهد)
        global.__Html3D_HtmlDomParser = HtmlDomParser;
    }

})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);

// ✅ التصدير الحقيقي كـ ES module — هذا ما يستورده main.js فعلياً:
//    import { ScadParser } from '../Html3D.js';
// يعمل لأن الكود أعلاه (الـ IIFE) يُنفَّذ بشكل متزامن أولاً عند تحميل
// هذا الملف كموديول، فتكون window.__Html3D_ScadParser جاهزة قبل وصول
// التنفيذ إلى هذا السطر.
export const ScadParser = (typeof window !== 'undefined' ? window : globalThis).__Html3D_ScadParser;
export const HtmlDomParser = (typeof window !== 'undefined' ? window : globalThis).__Html3D_HtmlDomParser;