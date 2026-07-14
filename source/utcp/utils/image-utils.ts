import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

interface IRgbaImage {
    width: number;
    height: number;
    data: Buffer;
}

/**
 * Decodes a PNG or JPEG file into a raw RGBA8 buffer, dispatching by file signature
 * rather than extension since Cocos asset source files aren't guaranteed to match one.
 */
function decodeImage(buffer: Buffer): IRgbaImage {
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) {
        const png = PNG.sync.read(buffer);
        return { width: png.width, height: png.height, data: png.data };
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
        return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
    }
    throw new Error('Unsupported image format: only PNG and JPEG source files can be previewed.');
}

/**
 * Box-average downscale of an RGBA8 buffer. Only used to shrink (never to enlarge),
 * so a simple area-average avoids the aliasing nearest-neighbor would introduce.
 */
function downscaleRgba(src: Buffer, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
    const dst = Buffer.alloc(dstW * dstH * 4);
    const xRatio = srcW / dstW;
    const yRatio = srcH / dstH;

    for (let dy = 0; dy < dstH; dy++) {
        const sy0 = Math.floor(dy * yRatio);
        const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.floor((dy + 1) * yRatio)));
        for (let dx = 0; dx < dstW; dx++) {
            const sx0 = Math.floor(dx * xRatio);
            const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.floor((dx + 1) * xRatio)));

            let r = 0, g = 0, b = 0, a = 0, count = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0; sx < sx1; sx++) {
                    const si = (sy * srcW + sx) * 4;
                    r += src[si];
                    g += src[si + 1];
                    b += src[si + 2];
                    a += src[si + 3];
                    count++;
                }
            }

            const di = (dy * dstW + dx) * 4;
            dst[di] = Math.round(r / count);
            dst[di + 1] = Math.round(g / count);
            dst[di + 2] = Math.round(b / count);
            dst[di + 3] = Math.round(a / count);
        }
    }

    return dst;
}

/**
 * Reads a PNG/JPEG file, fits it within maxSize (preserving aspect ratio, centered,
 * matching Jimp's `contain`), flattens transparency onto an opaque background color,
 * and returns a JPEG-encoded buffer at the given quality.
 */
export function renderImagePreviewJpeg(
    sourceBuffer: Buffer,
    maxSize: number,
    backgroundColor: { r: number, g: number, b: number },
    jpegQuality: number,
): Buffer {
    const source = decodeImage(sourceBuffer);

    let placed = source.data;
    let placedW = source.width;
    let placedH = source.height;
    let outW = source.width;
    let outH = source.height;
    let offsetX = 0;
    let offsetY = 0;

    if (source.width > maxSize || source.height > maxSize) {
        const scale = Math.min(maxSize / source.width, maxSize / source.height);
        placedW = Math.max(1, Math.round(source.width * scale));
        placedH = Math.max(1, Math.round(source.height * scale));
        placed = downscaleRgba(source.data, source.width, source.height, placedW, placedH);
        outW = maxSize;
        outH = maxSize;
        offsetX = Math.floor((outW - placedW) / 2);
        offsetY = Math.floor((outH - placedH) / 2);
    }

    // Fill the output canvas with the opaque background color, then alpha-blend
    // the (possibly letterboxed) image on top — this both flattens transparency
    // and fills any centering padding in a single pass.
    const out = Buffer.alloc(outW * outH * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = backgroundColor.r;
        out[i + 1] = backgroundColor.g;
        out[i + 2] = backgroundColor.b;
        out[i + 3] = 255;
    }

    for (let y = 0; y < placedH; y++) {
        for (let x = 0; x < placedW; x++) {
            const si = (y * placedW + x) * 4;
            const alpha = placed[si + 3] / 255;
            if (alpha <= 0) continue;

            const di = ((y + offsetY) * outW + (x + offsetX)) * 4;
            out[di] = Math.round(placed[si] * alpha + out[di] * (1 - alpha));
            out[di + 1] = Math.round(placed[si + 1] * alpha + out[di + 1] * (1 - alpha));
            out[di + 2] = Math.round(placed[si + 2] * alpha + out[di + 2] * (1 - alpha));
        }
    }

    return jpeg.encode({ width: outW, height: outH, data: out }, jpegQuality).data;
}
