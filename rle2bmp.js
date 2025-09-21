/*****
Ported from Ferdinand Zeppelin project "Commandos Modding" (https://sites.google.com/site/commandosmod/downloads)
******/



const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function u8(b){ return b & 0xFF; }
function read3le(buf, off){ return (u8(buf[off]) | (u8(buf[off+1])<<8) | (u8(buf[off+2])<<16)); }
function pad4(n){ const p = (4 - (n % 4)) & 3; return p === 4 ? 0 : p; }

function writeIndexedBmp(outPath, width, height, palette1024, rows /*Buffer[height], each length width+pad*/) {
  const rowSize = rows[0].length;
  const pixelBytes = rowSize * height;
  const bfOffBits = 14 + 40 + 1024;
  const bfSize = bfOffBits + pixelBytes;

  const fh = Buffer.alloc(14);
  fh.write('BM', 0, 'ascii');
  fh.writeUInt32LE(bfSize, 2);
  fh.writeUInt16LE(0, 6);
  fh.writeUInt16LE(0, 8);
  fh.writeUInt32LE(bfOffBits, 10);

  const ih = Buffer.alloc(40);
  ih.writeUInt32LE(40, 0);
  ih.writeInt32LE(width, 4);
  ih.writeInt32LE(height, 8);   // bottom-up
  ih.writeUInt16LE(1, 12);
  ih.writeUInt16LE(8, 14);      // 8bpp indexed
  ih.writeUInt32LE(0, 16);      // BI_RGB
  ih.writeUInt32LE(pixelBytes, 20);
  ih.writeInt32LE(0, 24);
  ih.writeInt32LE(0, 28);
  ih.writeUInt32LE(256, 32);    // clrUsed
  ih.writeUInt32LE(0, 36);

  const f = fs.openSync(outPath, 'w');
  try{
    fs.writeSync(f, fh);
    fs.writeSync(f, ih);
    fs.writeSync(f, palette1024);
    // write bottom-up
    for(let r = height - 1; r >= 0; --r) fs.writeSync(f, rows[r]);
  } finally { fs.closeSync(f); }
}

function write32BitBmp(outPath, width, height, bgraRows /*Buffer[height], length width*4*/) {
  const rowSize = bgraRows[0].length;
  const pixelBytes = rowSize * height;
  const bfOffBits = 14 + 40;
  const bfSize = bfOffBits + pixelBytes;

  const fh = Buffer.alloc(14);
  fh.write('BM', 0, 'ascii');
  fh.writeUInt32LE(bfSize, 2);
  fh.writeUInt16LE(0, 6);
  fh.writeUInt16LE(0, 8);
  fh.writeUInt32LE(bfOffBits, 10);

  const ih = Buffer.alloc(40);
  ih.writeUInt32LE(40, 0);
  ih.writeInt32LE(width, 4);
  ih.writeInt32LE(height, 8);   // bottom-up
  ih.writeUInt16LE(1, 12);
  ih.writeUInt16LE(32, 14);     // 32bpp
  ih.writeUInt32LE(0, 16);      // BI_RGB
  ih.writeUInt32LE(pixelBytes, 20);
  ih.writeInt32LE(0, 24);
  ih.writeInt32LE(0, 28);
  ih.writeUInt32LE(0, 32);
  ih.writeUInt32LE(0, 36);

  const f = fs.openSync(outPath, 'w');
  try{
    fs.writeSync(f, fh);
    fs.writeSync(f, ih);
    for(let r = height - 1; r >= 0; --r) fs.writeSync(f, bgraRows[r]);
  } finally { fs.closeSync(f); }
}

function decodeRLEBuffer(file) {
  let p = 0;
  // === Parse header exactly like Rle2Bmp.java ===
  p += 2; // signature passthrough
  const var9 = read3le(file, p); p += 3;
  p += 5;
  const var10 = read3le(file, p); p += 3;
  p += 5;
  const width = read3le(file, p); p += 3;
  p += 1; // align
  const height = read3le(file, p); p += 3;
  p += 1; // align
  p += 28; // critical skip before palette

  const rowPad = pad4(width);
  const rowSize = width + rowPad;
  const var16 = Math.floor((var10 - 54 - 1024 - 12) / 4);

  const palette = Buffer.from(file.subarray(p, p + 1024));
  p += 1024;

  p += var16 * 4;
  p += 12;

  const decodeBytes = (var9 - 1024 - 54 - var16 * 4 - 12);
  let consumed = 0;

  const rows = Array.from({length: height}, () => Buffer.alloc(rowSize, 0));
  const maskRows = Array.from({length: height}, () => Buffer.alloc(rowSize, 0));

  let x = 0, y = 0;
  while (consumed < decodeBytes && y < height && p < file.length) {
    let b = file[p++]; consumed++; if (b === undefined) break;
    let ctrl = (b & 0x80) ? (b - 256) : b; // signed
    if (ctrl < 0) ctrl = 256 + ctrl;      // 0..255

    if (ctrl === 255) {
      if (p >= file.length) break;
      let c = file[p++]; consumed++;
      c = (c & 0x80) ? (c - 256) : c;
      let count = c < 0 ? 256 + c : c;
      for (let i = 0; i < count; i++) {
        rows[y][x] = 255;
        maskRows[y][x] = 0;
        x++;
        if (x === width) { x = 0; y++; if (y >= height) break; }
      }
    } else if (ctrl === 254) {
      if (p >= file.length) break;
      let c = file[p++]; consumed++;
      c = (c & 0x80) ? (c - 256) : c;
      let count = c < 0 ? 256 + c : c;
      for (let i = 0; i < count; i++) {
        if (p >= file.length) break;
        rows[y][x] = file[p++];
        maskRows[y][x] = 128;
        consumed++;
        x++;
        if (x === width) { x = 0; y++; if (y >= height) break; }
      }
    } else {
      let count = ctrl;
      for (let i = 0; i < count; i++) {
        if (p >= file.length) break;
        rows[y][x] = file[p++];
        maskRows[y][x] = 255;
        consumed++;
        x++;
        if (x === width) { x = 0; y++; if (y >= height) break; }
      }
    }
  }

  return { width, height, palette, rows, maskRows };
}

async function convertOneRLE(inPath, { makeMask, makeRgba }) {
  const file = await fsp.readFile(inPath);
  const { width, height, palette, rows, maskRows } = decodeRLEBuffer(file);

  // Output folder: sibling directory named after the RLE file (no extension)
  const dir = path.dirname(inPath);
  const nameNoExt = path.parse(inPath).name;
  const outDir = path.join(dir, nameNoExt) + '_RLE';
  await fsp.mkdir(outDir, { recursive: true });

  const outBase = path.join(outDir, nameNoExt);

  if (makeRgba) {
    const bgraRows = Array.from({length: height}, () => Buffer.alloc(width * 4));
    for (let r = 0; r < height; r++) {
      const dst = bgraRows[r];
      const srcIdx = rows[r];
      const srcMask = maskRows[r];
      for (let x = 0; x < width; x++) {
        const idx = srcIdx[x];
        const palOff = idx * 4;
        dst[x*4 + 0] = palette[palOff + 0];
        dst[x*4 + 1] = palette[palOff + 1];
        dst[x*4 + 2] = palette[palOff + 2];
        dst[x*4 + 3] = srcMask[x]; // 0/128/255
      }
    }
    const rgbaOut = `${outBase}.rgba.bmp`;
    write32BitBmp(rgbaOut, width, height, bgraRows);
  } else {
    const imgOut = `${outBase}.bmp`;
    writeIndexedBmp(imgOut, width, height, palette, rows);
    if (makeMask) {
      const maskPalette = Buffer.alloc(1024);
      for (let i = 0; i < 256; i++) {
        maskPalette[i*4 + 0] = i;
        maskPalette[i*4 + 1] = i;
        maskPalette[i*4 + 2] = i;
        maskPalette[i*4 + 3] = 0;
      }
      const maskOut = `${outBase}.mask.bmp`;
      writeIndexedBmp(maskOut, width, height, maskPalette, maskRows);
    }
  }

  // Delete original RLE after successful conversion
  await fsp.unlink(inPath);
  return outDir;
}

async function walkDir(dir, out=[]) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      await walkDir(full, out);
    } else if (d.isFile()) {
      const ext = path.extname(d.name).toLowerCase();
      if (ext === '.rle') out.push(full);
    }
  }
  return out;
}

async function batchProcess(rootDir, { makeMask, makeRgba }) {
  const files = await walkDir(rootDir);
  if (files.length === 0) {
    console.log(`No .rle files found under: ${rootDir}`);
    return;
  }
  console.log(`Found ${files.length} .rle file(s). Converting...\n`);
  for (const f of files) {
    try {
      const outDir = await convertOneRLE(f, { makeMask, makeRgba });
      console.log(`OK: ${f} -> ${outDir} (deleted original)`);
    } catch (e) {
      console.error(`FAIL: ${f} — ${e.message || e}`);
    }
  }
}

async function main(){
  const makeMask = !process.argv.includes('--no-mask');
  const makeRgba = process.argv.includes('--rgba');

  // If an input path is provided, process just that file (legacy behavior).
  const arg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (arg) {
    const outDir = await convertOneRLE(arg, { makeMask, makeRgba });
    console.log(`\nConverted:\n  ${arg} -> ${outDir} (deleted original)`);
    return;
  }

  // Batch mode: recursively scan `${__dirname}/output`
  const rootDir = path.join(__dirname, 'output');
  await fsp.mkdir(rootDir, { recursive: true });
  await batchProcess(rootDir, { makeMask, makeRgba });
}

if (require.main === module) {
  main().catch(e => {
    console.error('Error:', e?.message || e);
    process.exit(1);
  });
}
