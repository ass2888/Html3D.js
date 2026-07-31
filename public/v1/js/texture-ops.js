// js/texture-ops.js
// ============================================================
//  مولّد Textures إجرائية (Canvas 2D) — لا يحتاج صوراً خارجية إطلاقاً.
//  مشترك بين المحرر (main.js، لبناء نافذة اختيار الـ texture) وبين
//  المكتبة وقت التشغيل (Html3D.js، لتنفيذ توجيه texture() عند استيراد
//  SCAD)، حتى يُنتج الطرفان نفس الصورة تماماً من نفس الاسم/الخيارات.
// ============================================================
import * as THREE from 'three';

// ------------------------------------------------------------
//  التصنيفات + قائمة الأنماط (تُستخدم لبناء نافذة الاختيار في المحرر)
// ------------------------------------------------------------
export const TEXTURE_CATEGORIES = [
    {
        id: 'basic', label: 'Basic',
        patterns: ['checkerboard', 'stripes', 'diagonal-stripes', 'grid', 'crosshatch', 'dots', 'noise', 'gradient']
    },
    {
        id: 'stone', label: 'Stone & Ground',
        patterns: ['brick', 'marble', 'granite', 'concrete', 'sand', 'cobblestone', 'tiles']
    },
    {
        id: 'organic', label: 'Organic',
        patterns: ['wood', 'bark', 'grass', 'water', 'clouds', 'leaves']
    },
    {
        id: 'fabric', label: 'Fabric & Surface',
        patterns: ['fabric', 'leather', 'denim', 'camouflage', 'rust', 'scratched-metal']
    },
    {
        id: 'geometric', label: 'Geometric',
        patterns: ['hexagon', 'honeycomb', 'diamond', 'triangles', 'chevron', 'herringbone']
    },
    {
        id: 'tech', label: 'Sci-Fi & Tech',
        patterns: ['circuit', 'hazard-stripes', 'carbon-fiber', 'digital-camo']
    }
];

export const TEXTURE_LABELS = {
    checkerboard: 'Checkerboard', stripes: 'Stripes', 'diagonal-stripes': 'Diagonal Stripes',
    grid: 'Grid', crosshatch: 'Crosshatch', dots: 'Dots', noise: 'Noise', gradient: 'Gradient',
    brick: 'Brick', marble: 'Marble', granite: 'Granite', concrete: 'Concrete', sand: 'Sand',
    cobblestone: 'Cobblestone', tiles: 'Tiles',
    wood: 'Wood', bark: 'Bark', grass: 'Grass', water: 'Water', clouds: 'Clouds', leaves: 'Leaves',
    fabric: 'Fabric', leather: 'Leather', denim: 'Denim', camouflage: 'Camouflage',
    rust: 'Rust', 'scratched-metal': 'Scratched Metal',
    hexagon: 'Hexagon', honeycomb: 'Honeycomb', diamond: 'Diamond', triangles: 'Triangles',
    chevron: 'Chevron', herringbone: 'Herringbone',
    circuit: 'Circuit', 'hazard-stripes': 'Hazard Stripes', 'carbon-fiber': 'Carbon Fiber',
    'digital-camo': 'Digital Camo'
};

export const ALL_TEXTURE_PATTERNS = TEXTURE_CATEGORIES.flatMap(c => c.patterns);

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------
function rand(min, max) { return min + Math.random() * (max - min); }

function mixHex(hexA, hexB, t) {
    const a = parseInt(hexA.replace('#', ''), 16), b = parseInt(hexB.replace('#', ''), 16);
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return `rgb(${r},${g},${bl})`;
}

function blobPath(ctx, cx, cy, r, irregularity = 0.35, points = 10) {
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
        const a = (i / points) * Math.PI * 2;
        const rr = r * (1 - irregularity / 2 + Math.random() * irregularity);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

// ------------------------------------------------------------
//  الرسم الفعلي — يعمل على أي 2D context (يُستخدم لكل من التكسّتشر
//  الكامل 512×512 ومعاينات الأيقونات الصغيرة في نافذة الاختيار)
// ------------------------------------------------------------
export function drawPatternToContext(ctx, size, pattern, options = {}) {
    const color1 = options.color1 || '#8b5a2b';
    const color2 = options.color2 || '#5c3a1e';
    const color3 = options.color3 || mixHex(color1, color2, 0.5);
    const cells = options.cells || 8;

    switch (pattern) {
        case 'checkerboard': {
            const cellSize = size / cells;
            for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
                ctx.fillStyle = (x + y) % 2 === 0 ? color1 : color2;
                ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
            }
            break;
        }
        case 'stripes': {
            const w = size / cells;
            for (let i = 0; i < cells; i++) {
                ctx.fillStyle = i % 2 === 0 ? color1 : color2;
                ctx.fillRect(i * w, 0, w, size);
            }
            break;
        }
        case 'diagonal-stripes': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            const w = (size / cells) * 1.4;
            ctx.lineWidth = w * 0.6;
            for (let i = -cells; i < cells * 2; i++) {
                ctx.beginPath();
                ctx.moveTo(i * w, 0);
                ctx.lineTo(i * w + size, size);
                ctx.stroke();
            }
            break;
        }
        case 'grid': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            ctx.lineWidth = 2;
            const cellSize = size / cells;
            for (let i = 0; i <= cells; i++) {
                ctx.beginPath(); ctx.moveTo(i * cellSize, 0); ctx.lineTo(i * cellSize, size); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(0, i * cellSize); ctx.lineTo(size, i * cellSize); ctx.stroke();
            }
            break;
        }
        case 'crosshatch': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            ctx.globalAlpha = 0.6;
            ctx.lineWidth = 1.2;
            const step = size / cells;
            for (let i = -cells; i < cells * 2; i++) {
                ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step + size, size); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(i * step, size); ctx.lineTo(i * step + size, 0); ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'dots': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = color2;
            const cellSize = size / cells;
            const r = cellSize * 0.3;
            for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
                ctx.beginPath();
                ctx.arc(x * cellSize + cellSize / 2, y * cellSize + cellSize / 2, r, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }
        case 'noise': {
            const imgData = ctx.createImageData(size, size);
            for (let i = 0; i < imgData.data.length; i += 4) {
                const v = Math.floor(Math.random() * 255);
                imgData.data[i] = v; imgData.data[i + 1] = v; imgData.data[i + 2] = v; imgData.data[i + 3] = 255;
            }
            ctx.putImageData(imgData, 0, 0);
            break;
        }
        case 'gradient': {
            const grad = ctx.createLinearGradient(0, 0, size, size);
            grad.addColorStop(0, color1);
            grad.addColorStop(1, color2);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, size, size);
            break;
        }
        case 'brick': {
            ctx.fillStyle = color2;
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = color1;
            const rows = cells;
            const rowHeight = size / rows;
            const brickWidth = size / 4;
            const mortar = 3;
            for (let row = 0; row < rows; row++) {
                const offset = (row % 2) * (brickWidth / 2);
                for (let x = -brickWidth; x < size + brickWidth; x += brickWidth) {
                    ctx.fillRect(x + offset + mortar, row * rowHeight + mortar, brickWidth - mortar * 2, rowHeight - mortar * 2);
                }
            }
            break;
        }
        case 'wood': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            for (let i = 0; i < cells * 2; i++) {
                ctx.lineWidth = 1 + Math.random() * 2;
                ctx.beginPath();
                const baseY = (i / (cells * 2)) * size;
                ctx.moveTo(0, baseY);
                for (let x = 0; x <= size; x += 20) {
                    const y = baseY + Math.sin(x * 0.02 + i) * 8;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            break;
        }
        case 'marble': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            for (let i = 0; i < cells * 3; i++) {
                ctx.lineWidth = 0.5 + Math.random() * 1.5;
                ctx.globalAlpha = 0.4 + Math.random() * 0.4;
                ctx.beginPath();
                const startX = Math.random() * size;
                ctx.moveTo(startX, 0);
                let x = startX;
                for (let y = 0; y <= size; y += 15) {
                    x += (Math.random() - 0.5) * 25;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'granite': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const speckles = cells * 120;
            for (let i = 0; i < speckles; i++) {
                ctx.fillStyle = Math.random() < 0.5 ? color2 : color3;
                ctx.globalAlpha = rand(0.25, 0.8);
                const r = rand(0.8, 3);
                ctx.beginPath();
                ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'concrete': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            for (let i = 0; i < cells * 15; i++) {
                ctx.fillStyle = Math.random() < 0.5 ? color2 : color1;
                ctx.globalAlpha = rand(0.04, 0.15);
                const r = rand(size * 0.02, size * 0.09);
                ctx.beginPath();
                ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = '#000000';
            for (let i = 0; i < size * size * 0.02; i++) {
                ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'sand': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = color2;
            for (let i = 0; i < size * size * 0.03; i++) {
                ctx.globalAlpha = rand(0.15, 0.5);
                ctx.fillRect(Math.random() * size, Math.random() * size, rand(0.5, 1.5), rand(0.5, 1.5));
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'cobblestone': {
            ctx.fillStyle = color2;
            ctx.fillRect(0, 0, size, size);
            const cell = size / cells;
            for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
                const cx = x * cell + cell / 2 + rand(-cell * 0.15, cell * 0.15);
                const cy = y * cell + cell / 2 + rand(-cell * 0.15, cell * 0.15);
                ctx.fillStyle = mixHex(color1, color3, Math.random());
                blobPath(ctx, cx, cy, cell * 0.42, 0.25, 8);
                ctx.fill();
            }
            break;
        }
        case 'tiles': {
            const cellSize = size / cells;
            const pad = cellSize * 0.06;
            for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
                ctx.fillStyle = mixHex(color1, color2, rand(0, 0.18));
                const rx = x * cellSize + pad, ry = y * cellSize + pad, rw = cellSize - pad * 2, rh = cellSize - pad * 2;
                const r = Math.min(rw, rh) * 0.12;
                ctx.beginPath();
                ctx.moveTo(rx + r, ry);
                ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
                ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
                ctx.arcTo(rx, ry + rh, rx, ry, r);
                ctx.arcTo(rx, ry, rx + rw, ry, r);
                ctx.closePath();
                ctx.fill();
            }
            break;
        }
        case 'bark': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            for (let i = 0; i < cells * 3; i++) {
                ctx.lineWidth = rand(1, 4);
                ctx.globalAlpha = rand(0.3, 0.7);
                const baseX = (i / (cells * 3)) * size;
                ctx.beginPath();
                let x = baseX;
                ctx.moveTo(x, 0);
                for (let y = 0; y <= size; y += 12) {
                    x += rand(-6, 6);
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'grass': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            for (let i = 0; i < size * size * 0.01; i++) {
                const x = Math.random() * size, y = Math.random() * size;
                const h = rand(6, 16), lean = rand(-4, 4);
                ctx.globalAlpha = rand(0.4, 0.9);
                ctx.lineWidth = rand(0.8, 1.6);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + lean, y - h);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'water': {
            const grad = ctx.createLinearGradient(0, 0, 0, size);
            grad.addColorStop(0, color1);
            grad.addColorStop(1, color2);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = '#ffffff';
            for (let i = 0; i < cells * 3; i++) {
                ctx.globalAlpha = rand(0.05, 0.2);
                ctx.lineWidth = rand(1, 3);
                const baseY = Math.random() * size;
                ctx.beginPath();
                for (let x = 0; x <= size; x += 16) {
                    const y = baseY + Math.sin(x * 0.05 + i) * 6;
                    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'clouds': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            for (let i = 0; i < cells * 4; i++) {
                const cx = Math.random() * size, cy = Math.random() * size, r = rand(size * 0.06, size * 0.18);
                const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
                g.addColorStop(0, color2);
                g.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.globalAlpha = rand(0.25, 0.5);
                ctx.fillStyle = g;
                ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'leaves': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            for (let i = 0; i < cells * cells * 1.5; i++) {
                const x = Math.random() * size, y = Math.random() * size;
                const w = rand(6, 14), h = w * rand(1.6, 2.2), a = Math.random() * Math.PI;
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(a);
                ctx.fillStyle = mixHex(color2, color3, Math.random());
                ctx.globalAlpha = rand(0.5, 0.9);
                ctx.beginPath();
                ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'fabric': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const step = size / (cells * 2);
            ctx.strokeStyle = color2;
            ctx.lineWidth = step * 0.5;
            ctx.globalAlpha = 0.55;
            for (let i = 0; i < cells * 2; i++) {
                ctx.beginPath();
                if (i % 2 === 0) { ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); }
                else { ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'leather': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            for (let i = 0; i < cells * 20; i++) {
                ctx.globalAlpha = rand(0.05, 0.18);
                ctx.fillStyle = Math.random() < 0.5 ? color2 : '#000000';
                blobPath(ctx, Math.random() * size, Math.random() * size, rand(6, 22), 0.5, 7);
                ctx.fill();
            }
            ctx.globalAlpha = 0.08;
            ctx.strokeStyle = color2;
            ctx.lineWidth = 1;
            for (let i = 0; i < size * size * 0.002; i++) {
                const x = Math.random() * size, y = Math.random() * size;
                ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rand(-8, 8), y + rand(-8, 8)); ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'denim': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const w = size / (cells * 3);
            ctx.lineWidth = w * 0.7;
            for (let i = -cells * 3; i < cells * 6; i++) {
                ctx.strokeStyle = i % 2 === 0 ? color2 : mixHex(color1, color2, 0.5);
                ctx.globalAlpha = 0.5;
                ctx.beginPath();
                ctx.moveTo(i * w, 0);
                ctx.lineTo(i * w + size * 0.3, size);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'camouflage': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const palette = [color2, color3, mixHex(color1, color2, 0.3)];
            for (let i = 0; i < cells * 2.5; i++) {
                ctx.fillStyle = palette[i % palette.length];
                ctx.globalAlpha = rand(0.7, 1);
                blobPath(ctx, Math.random() * size, Math.random() * size, rand(size * 0.08, size * 0.2), 0.45, 9);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'rust': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            for (let i = 0; i < cells * 8; i++) {
                ctx.fillStyle = color2;
                ctx.globalAlpha = rand(0.15, 0.5);
                blobPath(ctx, Math.random() * size, Math.random() * size, rand(size * 0.03, size * 0.1), 0.6, 8);
                ctx.fill();
            }
            const imgData = ctx.getImageData(0, 0, size, size);
            for (let i = 0; i < imgData.data.length; i += 4) {
                const n = (Math.random() - 0.5) * 20;
                imgData.data[i] = Math.min(255, Math.max(0, imgData.data[i] + n));
                imgData.data[i + 1] = Math.min(255, Math.max(0, imgData.data[i + 1] + n));
                imgData.data[i + 2] = Math.min(255, Math.max(0, imgData.data[i + 2] + n));
            }
            ctx.putImageData(imgData, 0, 0);
            ctx.globalAlpha = 1;
            break;
        }
        case 'scratched-metal': {
            const grad = ctx.createLinearGradient(0, 0, size, size);
            grad.addColorStop(0, color1);
            grad.addColorStop(0.5, mixHex(color1, '#ffffff', 0.15));
            grad.addColorStop(1, color1);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            for (let i = 0; i < cells * 15; i++) {
                ctx.globalAlpha = rand(0.1, 0.35);
                ctx.lineWidth = rand(0.5, 1.5);
                const x = Math.random() * size, y = Math.random() * size, len = rand(20, 120), a = rand(-0.3, 0.3);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'hexagon': case 'honeycomb': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const outline = pattern === 'honeycomb';
            const hexR = size / cells / 1.6;
            const hexW = hexR * 2, hexH = Math.sqrt(3) * hexR;
            for (let row = -1; row * hexH * 0.75 < size + hexH; row++) {
                for (let col = -1; col * hexW * 1.5 < size + hexW; col++) {
                    const cx = col * hexW * 0.75 * 2 + (row % 2 === 0 ? 0 : hexW * 0.75);
                    const cy = row * hexH * 0.75 * 2;
                    ctx.beginPath();
                    for (let i = 0; i < 6; i++) {
                        const a = Math.PI / 3 * i;
                        const px = cx + Math.cos(a) * hexR, py = cy + Math.sin(a) * hexR;
                        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
                    }
                    ctx.closePath();
                    if (outline) {
                        ctx.strokeStyle = color2;
                        ctx.lineWidth = Math.max(2, hexR * 0.12);
                        ctx.stroke();
                    } else {
                        ctx.fillStyle = ((row + col) % 2 === 0) ? color1 : color2;
                        ctx.fill();
                        ctx.strokeStyle = mixHex(color1, '#000000', 0.2);
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    }
                }
            }
            break;
        }
        case 'diamond': {
            const cellSize = size / cells;
            for (let y = -1; y <= cells; y++) for (let x = -1; x <= cells; x++) {
                ctx.fillStyle = (x + y) % 2 === 0 ? color1 : color2;
                const cx = x * cellSize + cellSize / 2, cy = y * cellSize + cellSize / 2;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(Math.PI / 4);
                ctx.fillRect(-cellSize / 2, -cellSize / 2, cellSize, cellSize);
                ctx.restore();
            }
            break;
        }
        case 'triangles': {
            const cellSize = size / cells;
            for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
                const px = x * cellSize, py = y * cellSize;
                ctx.fillStyle = color1;
                ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + cellSize, py); ctx.lineTo(px, py + cellSize); ctx.closePath(); ctx.fill();
                ctx.fillStyle = color2;
                ctx.beginPath(); ctx.moveTo(px + cellSize, py); ctx.lineTo(px + cellSize, py + cellSize); ctx.lineTo(px, py + cellSize); ctx.closePath(); ctx.fill();
            }
            break;
        }
        case 'chevron': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const step = size / cells;
            ctx.strokeStyle = color2;
            ctx.lineWidth = step * 0.4;
            for (let row = -1; row * step < size + step; row++) {
                ctx.beginPath();
                for (let x = 0; x <= size + step; x += step) {
                    const y = row * step * 2 + (Math.round(x / step) % 2 === 0 ? 0 : step);
                    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            break;
        }
        case 'herringbone': {
            ctx.fillStyle = color2;
            ctx.fillRect(0, 0, size, size);
            const plank = size / cells, len = plank * 3;
            for (let y = -len; y < size + len; y += plank * 2) {
                for (let x = -len; x < size + len; x += plank * 2) {
                    ctx.save();
                    ctx.translate(x, y);
                    ctx.rotate(Math.PI / 4);
                    ctx.fillStyle = color1;
                    ctx.fillRect(-len / 2, -plank / 2 + 1, len, plank - 2);
                    ctx.restore();
                    ctx.save();
                    ctx.translate(x + plank, y + plank);
                    ctx.rotate(-Math.PI / 4);
                    ctx.fillStyle = mixHex(color1, '#000000', 0.12);
                    ctx.fillRect(-len / 2, -plank / 2 + 1, len, plank - 2);
                    ctx.restore();
                }
            }
            break;
        }
        case 'circuit': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.strokeStyle = color2;
            ctx.fillStyle = color2;
            const step = size / cells;
            for (let i = 0; i < cells * 3; i++) {
                let x = Math.round(Math.random() * cells) * step;
                let y = Math.round(Math.random() * cells) * step;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, y);
                const segs = Math.floor(rand(2, 5));
                for (let s = 0; s < segs; s++) {
                    if (Math.random() < 0.5) x += (Math.random() < 0.5 ? 1 : -1) * step;
                    else y += (Math.random() < 0.5 ? 1 : -1) * step;
                    x = Math.max(0, Math.min(size, x));
                    y = Math.max(0, Math.min(size, y));
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }
        case 'hazard-stripes': {
            ctx.save();
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = color2;
            const w = size / cells;
            ctx.translate(size / 2, size / 2);
            ctx.rotate(Math.PI / 4);
            ctx.translate(-size, -size);
            for (let i = 0; i < cells * 3; i += 2) {
                ctx.fillRect(i * w, -size, w, size * 3);
            }
            ctx.restore();
            break;
        }
        case 'carbon-fiber': {
            const weave = Math.max(4, Math.round(size / (cells * 6)));
            for (let y = 0; y < size; y += weave) {
                for (let x = 0; x < size; x += weave) {
                    const alt = (Math.floor(x / weave) + Math.floor(y / weave)) % 2 === 0;
                    ctx.fillStyle = alt ? color1 : mixHex(color1, '#ffffff', 0.12);
                    ctx.fillRect(x, y, weave - 1, weave - 1);
                }
            }
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = color2;
            ctx.lineWidth = 0.5;
            for (let i = 0; i < size; i += weave * 2) {
                ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
            }
            ctx.globalAlpha = 1;
            break;
        }
        case 'digital-camo': {
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
            const block = size / (cells * 2);
            const palette = [color1, color2, color3];
            for (let y = 0; y < size; y += block) {
                for (let x = 0; x < size; x += block) {
                    if (Math.random() < 0.55) {
                        ctx.fillStyle = palette[Math.floor(Math.random() * palette.length)];
                        ctx.fillRect(x, y, block, block);
                    }
                }
            }
            break;
        }
        default:
            ctx.fillStyle = color1;
            ctx.fillRect(0, 0, size, size);
    }
}

// ------------------------------------------------------------
//  ينشئ THREE.CanvasTexture جاهزة للاستخدام كـ material.map
// ------------------------------------------------------------
export function generateProceduralTexture(pattern, options = {}) {
    const size = options.size || 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    drawPatternToContext(ctx, size, pattern, options);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
}

// ------------------------------------------------------------
//  يرسم معاينة صغيرة داخل canvas موجود مسبقاً (لأيقونات نافذة الاختيار)
// ------------------------------------------------------------
export function drawPatternPreview(canvas, pattern, options = {}) {
    const size = canvas.width;
    const ctx = canvas.getContext('2d');
    drawPatternToContext(ctx, size, pattern, options);
}
