/*****
Ported from Ferdinand Zeppelin project "Commandos Modding" (https://sites.google.com/site/commandosmod/downloads)
******/

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function pad4(n) { const p = (4 - (n % 4)) & 3; return p === 4 ? 0 : p; }
function readUInt16LE(b, o) { return b.readUInt16LE(o); }
function readInt32LE(b, o)  { return b.readInt32LE(o); }
function readUInt32LE(b, o) { return b.readUInt32LE(o); }

function write3le(num) {
  const b = Buffer.alloc(3);
  b[0] = num & 0xFF;
  b[1] = (num >>> 8) & 0xFF;
  b[2] = (num >>> 16) & 0xFF;
  return b;
}

async function readFileSafe(p) {
  try { return await fsp.readFile(p); } catch { return null; }
}

// Parse 8-bit indexed BI_RGB BMP → { width, height, palette(1024), rows[height](width+pad) }
function parseIndexedBmp(buf) {
  if (buf.slice(0, 2).toString('ascii') !== 'BM') throw new Error('Not a BMP');
  const dibSize = readUInt32LE(buf, 14);
  if (dibSize < 40) throw new Error('Unsupported DIB header');

  const width  = readInt32LE(buf, 18);
  const height = readInt32LE(buf, 22);
  const planes = readUInt16LE(buf, 26);
  const bitCnt = readUInt16LE(buf, 28);
  const compression = readUInt32LE(buf, 30);
  const clrUsed = readUInt32LE(buf, 46);
  const offBits = readUInt32LE(buf, 10);

  if (planes !== 1) throw new Error('planes != 1');
  if (!(bitCnt === 8 && compression === 0)) throw new Error('Expected 8bpp BI_RGB');

  const heightAbs = Math.abs(height);
  const paletteEntries = clrUsed && clrUsed !== 0 ? clrUsed : 256;

  const palette = Buffer.alloc(1024, 0);
  const paletteStart = 14 + dibSize;
  buf.copy(palette, 0, paletteStart, paletteStart + Math.min(1024, paletteEntries * 4));

  const rowPad = pad4(width);
  const rows = Array.from({ length: heightAbs }, () => Buffer.alloc(width + rowPad, 0));

  // BMP stored bottom-up if height > 0
  let src = offBits;
  for (let r = heightAbs - 1; r >= 0; r--) {
    buf.copy(rows[r], 0, src, src + width);
    src += (width + rowPad);
  }
  return { width, height: heightAbs, palette, rows };
}

// Read mask BMP and create {maskRows[height][width], classMap[256]}
function parseMaskBmp(buf, expectedW, expectedH) {
  const { width, height, rows, palette } = parseIndexedBmp(buf);
  if (width !== expectedW || height !== expectedH) throw new Error('Mask BMP dimensions mismatch');

  // Classify indices by mask palette color (BGRA in palette)
  const classMap = new Array(256).fill(1); // default = absolute (type 1)
  for (let i = 0; i < 256; i++) {
    const b = palette[i * 4 + 0], g = palette[i * 4 + 1], r = palette[i * 4 + 2];
    if (r === 0 && g === 0 && b === 0) classMap[i] = 0;               // black → transparent run
    else if (r === 255 && g === 255 && b === 255) classMap[i] = 2;    // white → literal
    else classMap[i] = 1;                                             // others → absolute
  }

  // Strip row padding for the encoder
  const maskRows = Array.from({ length: height }, (_, y) => {
    const out = Buffer.alloc(expectedW);
    rows[y].copy(out, 0, 0, expectedW);
    return out;
  });

  return { maskRows, classMap };
}

// Encode rows→custom RLE stream using mask-driven block types and chunk caps
function encodeToCustomRLE(rows, maskRows, width, classMap) {
  const height = rows.length;
  const out = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const maskIdx = maskRows ? maskRows[y][x] : 255;
      const type = maskRows ? classMap[maskIdx] : 2; // default literal if no mask

      // find run of same type
      let run = 1;
      while (x + run < width) {
        const mi = maskRows ? maskRows[y][x + run] : 255;
        const t2 = maskRows ? classMap[mi] : 2;
        if (t2 !== type) break;
        run++;
      }

      if (type === 0) {
        // transparent run: 0xFF, <count> (no pixel bytes). split by 255
        let rem = run;
        while (rem > 0) {
          const chunk = Math.min(255, rem);
          out.push(0xFF, chunk);
          x += chunk;
          rem -= chunk;
        }
      } else if (type === 1) {
        // absolute block: 0xFE, <count>, then <count bytes>. split by 255
        let rem = run;
        while (rem > 0) {
          const chunk = Math.min(255, rem);
          out.push(0xFE, chunk);
          for (let i = 0; i < chunk; i++) out.push(rows[y][x + i]);
          x += chunk;
          rem -= chunk;
        }
      } else {
        // literal block: <count>, then <count bytes>. split by 253
        let rem = run;
        while (rem > 0) {
          const chunk = Math.min(253, rem);
          out.push(chunk);
          for (let i = 0; i < chunk; i++) out.push(rows[y][x + i]);
          x += chunk;
          rem -= chunk;
        }
      }
    }
    // row pad is not encoded
  }
  return Buffer.from(out);
}

async function packOneFolder(folderPath) {
  const baseName = path.basename(folderPath); // e.g. "sprite.RLE"
  const parent = path.dirname(folderPath);
  const bmpPath  = path.join(folderPath, `${baseName}.bmp`);
  const maskPath = path.join(folderPath, `${baseName}.mask.bmp`);
  const rgbaPath = path.join(folderPath, `${baseName}.rgba.bmp`); // ignored

  const bmpBuf  = await readFileSafe(bmpPath);
  const maskBuf = await readFileSafe(maskPath);
  const rgbaBuf = await readFileSafe(rgbaPath);

  if (!bmpBuf && rgbaBuf) throw new Error('RGBA BMP found without indexed BMP; packing requires <name>.bmp');

  if (!bmpBuf) throw new Error(`Missing main indexed BMP at ${bmpPath}`);

  // Parse image
  const { width, height, palette, rows: rowsWithPad } = parseIndexedBmp(bmpBuf);
  const rows = rowsWithPad.map(r => r.subarray(0, width)); // drop pad

  // Parse mask (optional)
  let maskRows = null, classMap = null;
  if (maskBuf) {
    const m = parseMaskBmp(maskBuf, width, height);
    maskRows = m.maskRows;
    classMap = m.classMap;
  } else {
    classMap = new Array(256).fill(2); // no mask → literal
  }

  // Build RLE stream
  const stream = encodeToCustomRLE(rows, maskRows, width, classMap);

  // Container header (compatible with our decoder)
  const var16 = 0; // no per-row table
  const var10 = 54 + 1024 + 12 + var16 * 4;   // decoder uses this formula
  const var9  = 1024 + 54 + 12 + var16 * 4 + stream.length;

  const parts = [];
  parts.push(Buffer.from('BM', 'ascii'));     // 2 bytes
  parts.push(write3le(var9));                 // 3
  parts.push(Buffer.alloc(5, 0));             // 5
  parts.push(write3le(var10));                // 3
  parts.push(Buffer.alloc(5, 0));             // 5
  parts.push(write3le(width));                // 3
  parts.push(Buffer.alloc(1, 0));             // align
  parts.push(write3le(height));               // 3
  parts.push(Buffer.alloc(1, 0));             // align
  parts.push(Buffer.alloc(28, 0));            // reserved before palette
  if (palette.length !== 1024) throw new Error('Palette must be 1024 bytes');
  parts.push(palette);                        // 1024 palette (BGRA)
  parts.push(Buffer.alloc(12, 0));            // 12 bytes after palette/var16 table
  parts.push(stream);                         // RLE stream

  const outPath = path.join(parent, `${baseName}`); // <parent>/<FolderName>.RLE
  await fsp.writeFile(outPath, Buffer.concat(parts));

  // Delete the folder
  await fsp.rm(folderPath, { recursive: true, force: true });

  return outPath;
}

async function walkForRLEDirs(root, out) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const d of entries) {
    const full = path.join(root, d.name);
    if (d.isDirectory()) {
      if (d.name.toLowerCase().endsWith('.rle')) out.push(full);
      await walkForRLEDirs(full, out);
    }
  }
}

async function main() {
  const root = path.join(__dirname, 'output');
  await fsp.mkdir(root, { recursive: true });

  const rleDirs = [];
  await walkForRLEDirs(root, rleDirs);

  if (rleDirs.length === 0) {
    console.log(`No folders ending with ".RLE" found under: ${root}`);
    return;
  }

  console.log(`Found ${rleDirs.length} folder(s) ending with ".RLE". Packing...\n`);
  for (const dir of rleDirs) {
    try {
      const out = await packOneFolder(dir);
      console.log(`OK: ${dir} -> ${out} (folder deleted)`);
    } catch (e) {
      console.error(`FAIL: ${dir} — ${e.message || e}`);
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}