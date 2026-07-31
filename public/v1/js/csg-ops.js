// js/csg-ops.js
// ============================================================
//  عمليات Boolean حقيقية (Union / Difference / Intersection) باستخدام
//  مكتبة three-bvh-csg (انظر خريطة الاستيراد المضافة في Index.html).
//  هذا يستبدل السلوك القديم الذي كان يكتفي بتجميع (Group) الأجسام مع بعضها
//  دون أي عملية CSG فعلية.
// ============================================================
import * as THREE from 'three';
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';

const evaluator = new Evaluator();
evaluator.useGroups = false;

const OP_MAP = { union: ADDITION, difference: SUBTRACTION, intersection: INTERSECTION };

/**
 * ينفّذ عملية CSG بين شبكتين باستخدام تحويل العالم (world transform) الخاص
 * بكل منهما، ويعيد THREE.Mesh جديداً بإحداثيات محلية = نتيجة الدمج مباشرة
 * (transform هوية identity)، لأن النتيجة النهائية غالباً لا يكون لها مركز
 * دوران/انسحاب موحّد مشترك بين الجسمين الأصليين.
 * @param {THREE.Mesh} meshA
 * @param {THREE.Mesh} meshB
 * @param {'union'|'difference'|'intersection'} opName
 * @returns {THREE.Mesh}
 */
export function csgBoolean(meshA, meshB, opName) {
    const op = OP_MAP[opName];
    if (op === undefined) throw new Error(`Unknown CSG operation: ${opName}`);

    meshA.updateMatrixWorld(true);
    meshB.updateMatrixWorld(true);

    const brushA = new Brush(meshA.geometry.clone());
    brushA.matrix.copy(meshA.matrixWorld);
    brushA.matrixAutoUpdate = false;
    brushA.updateMatrixWorld(true);

    const brushB = new Brush(meshB.geometry.clone());
    brushB.matrix.copy(meshB.matrixWorld);
    brushB.matrixAutoUpdate = false;
    brushB.updateMatrixWorld(true);

    const resultBrush = evaluator.evaluate(brushA, brushB, op);
    const resultGeometry = resultBrush.geometry.clone();
    resultGeometry.computeVertexNormals();

    const material = (meshA.material && meshA.material.clone)
        ? meshA.material.clone()
        : new THREE.MeshStandardMaterial({ color: 0x88aaff, roughness: 0.3 });
    // شبكة أمان: نتيجة CSG قد لا تكون محدّبة، فنضمن رؤية كل الأوجه
    material.side = THREE.DoubleSide;

    const mesh = new THREE.Mesh(resultGeometry, material);
    mesh.userData.shapeType = 'custom';
    mesh.userData._verticesModified = true;
    mesh.userData.booleanOp = { type: opName };

    brushA.geometry.dispose();
    brushB.geometry.dispose();

    return mesh;
}

/**
 * يدمج قائمة من الشبكات بعملية واحدة بالتتابع:
 * النتيجة = ((A op B) op C) op D ...
 * @param {THREE.Mesh[]} meshes
 * @param {'union'|'difference'|'intersection'} opName
 * @returns {THREE.Mesh|null}
 */
export function csgBooleanMany(meshes, opName) {
    if (!meshes || meshes.length === 0) return null;
    if (meshes.length === 1) {
        const m = meshes[0].clone();
        m.geometry = meshes[0].geometry.clone();
        return m;
    }
    let acc = meshes[0];
    for (let i = 1; i < meshes.length; i++) {
        acc = csgBoolean(acc, meshes[i], opName);
    }
    return acc;
}
