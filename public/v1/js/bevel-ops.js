// js/bevel-ops.js
// ============================================================
//  أدوات هندسية خالصة (بدون اعتماد على THREE) لتنعيم/قطع زوايا
//  (Bevel / Chamfer) رأس واحد أو حافة واحدة في شبكة مثلثات.
//
//  تعمل مباشرة على نفس تمثيل البيانات المستخدم في كل مكان آخر بالمشروع:
//    positions: مصفوفة مسطّحة [x0,y0,z0, x1,y1,z1, ...]
//    indices:   مصفوفة مسطّحة لمثلثات فقط [a0,b0,c0, a1,b1,c1, ...]
//
//  هذا يعني أنها قابلة للاستخدام مباشرة مع geometry.attributes.position.array
//  و geometry.index.array في main.js، وأيضاً (بعد تثليث أي وجوه رباعية) مع
//  نظام points/faces الخاص بمحلّل SCAD في Html3D.js.
//
//  ملاحظة مهمة حول "بَفَل الحافة" (Bevel Edge):
//  التنفيذ الدقيق رياضياً لبفل حافة (شريط مستطيل يمتد بطول الحافة كاملة،
//  مستقل عن رأسيها) يحتاج بنية نصف-حافة (half-edge) كاملة مع تعبئة الزوايا
//  عند الرؤوس متعددة التكافؤ (n-valent) لتفادي أي فجوات في الشبكة. لإبقاء
//  هذا صلباً وآمناً مع أي شبكة عشوائية دون كسرها، bevelEdgeTopology تُطبّق
//  "بَفَل رأس" فعلي على كِلا طرفي الحافة (bevelVertexTopology على كل طرف على
//  حدة). هذا يعطي نتيجة صحيحة وخالية من الفجوات لكن يُنعّم الزاويتين معاً
//  عند طرفي الحافة، وليس فقط شريطاً على طول الحافة نفسها.
// ============================================================

function v3(positions, i) { return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]; }
function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function vLen(a) { return Math.hypot(a[0], a[1], a[2]); }

// يجد جار الرأس v داخل مثلث محدد (السابق واللاحق حسب اتجاه الدوران winding)
function neighborsInTri(indices, t, v) {
    const tri = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    const idx = tri.indexOf(v);
    if (idx === -1) return null;
    return { prev: tri[(idx + 2) % 3], next: tri[(idx + 1) % 3] };
}

/**
 * يُنعّم (يقطع) رأساً واحداً بمقدار "amount" على طول كل ضلع خارج منه،
 * ويُغلق الفجوة الناتجة بوجه مروحي جديد (Fan Cap).
 * @param {ArrayLike<number>} positions مصفوفة مسطّحة للنقاط
 * @param {ArrayLike<number>} indices مصفوفة مسطّحة لمثلثات فقط
 * @param {number} vIndex فهرس الرأس المطلوب تنعيمه
 * @param {number} amount مسافة القطع على طول كل ضلع مجاور
 * @returns {{positions:number[], indices:number[]}}
 */
export function bevelVertexTopology(positions, indices, vIndex, amount) {
    positions = Array.from(positions);
    indices = Array.from(indices);
    const triCount = indices.length / 3;

    // كل المثلثات التي تحتوي هذا الرأس
    const trisWithV = [];
    for (let t = 0; t < triCount; t++) {
        if (indices[t * 3] === vIndex || indices[t * 3 + 1] === vIndex || indices[t * 3 + 2] === vIndex) {
            trisWithV.push(t);
        }
    }
    if (trisWithV.length === 0) return { positions, indices };

    const info = {};
    trisWithV.forEach(t => { info[t] = neighborsInTri(indices, t, vIndex); });

    // ترتيب المثلثات في حلقة تدور حول الرأس (بنفس اتجاه دوران الأوجه):
    // المثلث التالي هو من يملك "prev" يساوي "next" للمثلث الحالي —
    // لأن حافة (v, next) مشتركة بين مثلثين، وتُقطع بالاتجاه المعاكس في كل منهما.
    const ordered = [trisWithV[0]];
    const used = new Set(ordered);
    let safety = trisWithV.length + 2;
    while (used.size < trisWithV.length && safety-- > 0) {
        const curNext = info[ordered[ordered.length - 1]].next;
        const found = trisWithV.find(t => !used.has(t) && info[t].prev === curNext);
        if (found === undefined) break; // حافة حرة على حدود الشبكة (رأس غير مُحاط بالكامل)
        ordered.push(found);
        used.add(found);
    }
    const isClosed = ordered.length === trisWithV.length &&
        info[ordered[ordered.length - 1]].next === info[ordered[0]].prev;

    const vPos = v3(positions, vIndex);
    const edgePointIdx = {}; // فهرس رأس جار -> فهرس النقطة الجديدة على ذلك الضلع

    function getEdgePoint(neighborIdx) {
        if (edgePointIdx[neighborIdx] !== undefined) return edgePointIdx[neighborIdx];
        const n = v3(positions, neighborIdx);
        const dir = vSub(n, vPos);
        const len = vLen(dir) || 1;
        const t = Math.min(amount / len, 0.49); // لا تتجاوز منتصف الضلع أبداً
        const np = vAdd(vPos, vScale(dir, t));
        const newIdx = positions.length / 3;
        positions.push(np[0], np[1], np[2]);
        edgePointIdx[neighborIdx] = newIdx;
        return newIdx;
    }

    // كل مثلث حول الرأس يتحوّل لمثلثين: يستبدل الرأس القديم بنقطتين جديدتين
    // على ضلعيه المجاورين، مع الحفاظ على اتجاه الدوران الأصلي (winding)
    ordered.forEach(t => {
        const { prev, next } = info[t];
        const prevPt = getEdgePoint(prev);
        const nextPt = getEdgePoint(next);
        // الترتيب الأصلي: prev -> v -> next
        indices[t * 3] = prev; indices[t * 3 + 1] = prevPt; indices[t * 3 + 2] = nextPt;
        indices.push(prev, nextPt, next);
    });

    // إغلاق الفجوة بوجه مروحي من كل النقاط الجديدة حول الرأس (فقط لو كانت
    // الحلقة مغلقة تماماً؛ رأس على حافة حرة للشبكة يُترك بلا غطاء تفادياً
    // لأي التباس في اتجاه الإغلاق)
    if (isClosed && ordered.length >= 3) {
        const capPts = ordered.map(t => edgePointIdx[info[t].next]);
        for (let i = 1; i < capPts.length - 1; i++) {
            indices.push(capPts[0], capPts[i], capPts[i + 1]);
        }
    }

    return { positions, indices };
}

/**
 * يُنعّم حافة كاملة (زوج رؤوس) بتطبيق bevelVertexTopology على كِلا طرفيها
 * بنفس المقدار — انظر الملاحظة أعلى الملف حول أسباب هذا الاختيار.
 */
export function bevelEdgeTopology(positions, indices, vA, vB, amount) {
    let result = bevelVertexTopology(positions, indices, vA, amount);
    result = bevelVertexTopology(result.positions, result.indices, vB, amount);
    return result;
}

// ===== أدوات مساعدة للتحويل بين تمثيل (points/faces متعدد الأضلاع) الخاص
// بمحلّل SCAD في Html3D.js وتمثيل (positions/indices) المثلّثة المستخدم هنا =====

// يُثلّث كل الوجوه (تدعم مضلعات بأي عدد أضلاع عبر Fan Triangulation) ويحوّلها
// إلى positions/indices مسطّحة
export function pointsFacesToFlat(points, faces) {
    const positions = [];
    points.forEach(p => positions.push(p[0], p[1], p[2]));
    const indices = [];
    faces.forEach(face => {
        if (face.length === 3) {
            indices.push(face[0], face[1], face[2]);
        } else if (face.length > 3) {
            for (let i = 1; i < face.length - 1; i++) {
                indices.push(face[0], face[i], face[i + 1]);
            }
        }
    });
    return { positions, indices };
}

// يحوّل positions/indices مسطّحة رجوعاً لصيغة points/faces (كل الوجوه مثلثات)
export function flatToPointsFaces(positions, indices) {
    const points = [];
    for (let i = 0; i < positions.length / 3; i++) {
        points.push([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    }
    const faces = [];
    for (let t = 0; t < indices.length / 3; t++) {
        faces.push([indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]);
    }
    return { points, faces };
}
