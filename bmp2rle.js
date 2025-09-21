/*****
Ported from Ferdinand Zeppelin project "Commandos Modding" (https://sites.google.com/site/commandosmod/downloads)
******/


const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function pad4(n){ const p = (4 - (n % 4)) & 3; return p === 4 ? 0 : p; }
function readU16(b,o){ return b.readUInt16LE(o); }
function readI32(b,o){ return b.readInt32LE(o); }
function readU32(b,o){ return b.readUInt32LE(o); }
async function readFileSafe(p){ try{ return await fsp.readFile(p); } catch { return null; } }

// ---- BMP parsing (8-bit indexed BI_RGB) ----
function parseIndexedBmp(buf){
  if (buf.slice(0,2).toString('ascii') !== 'BM') throw new Error('Not a BMP');
  const dibSize = readU32(buf, 14);
  if (dibSize < 40) throw new Error('Unsupported DIB header');

  const width  = readI32(buf, 18);
  const height = readI32(buf, 22);
  const planes = readU16(buf, 26);
  const bitCnt = readU16(buf, 28);
  const comp   = readU32(buf, 30);
  const clrUsed= readU32(buf, 46);
  const offBits= readU32(buf, 10);

  if (planes !== 1) throw new Error('planes != 1');
  if (!(bitCnt === 8 && comp === 0)) throw new Error('Expected 8bpp BI_RGB');

  const hAbs = Math.abs(height);
  const palEntries = clrUsed && clrUsed !== 0 ? clrUsed : 256;

  // Read up to 1024 bytes of palette (BGRA per entry)
  const palette = Buffer.alloc(1024, 0);
  const palStart = 14 + dibSize;
  buf.copy(palette, 0, palStart, palStart + Math.min(1024, palEntries*4));

  // Read pixel rows: BMP stores bottom-up if height>0
  const rowPad = pad4(width);
  const rowsWithPad = Array.from({length: hAbs}, () => Buffer.alloc(width + rowPad, 0));
  let src = offBits;
  for (let r = hAbs - 1; r >= 0; r--) { // flip to top-down in memory
    buf.copy(rowsWithPad[r], 0, src, src + width);
    src += (width + rowPad);
  }
  return { width, height: hAbs, palette, rowsWithPad };
}

// ---- Mask parsing -> classMap + maskRows (no index remap) ----
function parseMaskBmp(buf, expectedW, expectedH){
  const { width, height, rowsWithPad, palette } = parseIndexedBmp(buf);
  if (width !== expectedW || height !== expectedH) throw new Error('Mask BMP dimensions mismatch');

  // palette BGRA → class: 0 transparent(black), 1 absolute(other), 2 literal(white)
  const classMap = new Array(256).fill(1);
  for (let i = 0; i < 256; i++) {
    const b = palette[i*4 + 0], g = palette[i*4 + 1], r = palette[i*4 + 2];
    if (r === 0 && g === 0 && b === 0) classMap[i] = 0;            // black
    else if (r === 255 && g === 255 && b === 255) classMap[i] = 2; // white
    else classMap[i] = 1;                                          // other
  }

  // Strip pad to width-only rows
  const maskRows = Array.from({length: height}, (_, y) => {
    const out = Buffer.alloc(expectedW);
    rowsWithPad[y].copy(out, 0, 0, expectedW);
    return out;
  });
  return { maskRows, classMap };
}

// ---- Encoder (rows -> custom RLE) — returns stream + per-row sizes ----
function encodeToCustomRLE(rowsNoPad, maskRows, width, classMap){
  const height = rowsNoPad.length;
  const out = [];
  const rowSizes = new Array(height).fill(0);

  for (let y = 0; y < height; y++) {
    const rowStart = out.length;
    const row = rowsNoPad[y];
    let x = 0;

    while (x < width) {
      const maskIdx = maskRows ? maskRows[y][x] : 255;
      const type = maskRows ? classMap[maskIdx] : 2; // default to literal if no mask

      // grow run of same type
      let run = 1;
      while (x + run < width) {
        const mi = maskRows ? maskRows[y][x + run] : 255;
        const t2 = maskRows ? classMap[mi] : 2;
        if (t2 !== type) break;
        run++;
      }

      if (type === 0) {
        // transparent: 0xFF, <count>, chunks of 255, no payload
        let rem = run;
        while (rem > 0) {
          const chunk = Math.min(255, rem);
          out.push(0xFF, chunk);
          x += chunk;
          rem -= chunk;
        }
      } else if (type === 1) {
        // absolute: 0xFE, <count>, then <count bytes>, chunks of 255
        let rem = run;
        while (rem > 0) {
          const chunk = Math.min(255, rem);
          out.push(0xFE, chunk);
          for (let i = 0; i < chunk; i++) out.push(row[x + i]);
          x += chunk;
          rem -= chunk;
        }
      } else {
        // literal: <count>, then <count bytes>, chunks of 253
        let rem = run;
        while (rem > 0) {
          const chunk = Math.min(253, rem);
          out.push(chunk);
          for (let i = 0; i < chunk; i++) out.push(row[x + i]);
          x += chunk;
          rem -= chunk;
        }
      }
    }
    rowSizes[y] = out.length - rowStart;
  }

  return { stream: Buffer.from(out), rowSizes };
}

// ---- Helpers for little-endian writes ----
function u16le(n){ const b=Buffer.alloc(2); b.writeUInt16LE(n,0); return b; }
function u32le(n){ const b=Buffer.alloc(4); b.writeUInt32LE(n,0); return b; }

// ---- Java-style container with "libr" block + per-row table ----
function buildJavaStyleContainer(width, height, palette, rowSizes, stream){
  if (palette.length !== 1024) throw new Error('Palette must be 1024 bytes');

  // BITMAPFILEHEADER (14) + BITMAPINFOHEADER (40) — placeholders for size/offBits
  const fileHdr = Buffer.alloc(14);
  fileHdr.write('BM', 0, 'ascii');
  // bfSize @2, bfOffBits @10 will be patched later

  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);            // biSize
  dib.writeInt32LE(width, 4);
  dib.writeInt32LE(height, 8);
  dib.writeUInt16LE(1, 12);            // biPlanes
  dib.writeUInt16LE(8, 14);            // biBitCount
  dib.writeUInt32LE(4, 16);            // biCompression = BI_RLE4
  dib.writeUInt32LE(stream.length, 20);// biSizeImage
  dib.writeInt32LE(2835, 24);          // XPelsPerMeter
  dib.writeInt32LE(2835, 28);          // YPelsPerMeter
  dib.writeUInt32LE(0, 32);            // biClrUsed
  dib.writeUInt32LE(0, 36);            // biClrImportant

  // Java's extra block between palette and stream:
  // "libr" + width(2)+00(2) + height(2)+00(2) + 4 zero bytes + per-row cumulative table (rows 0..h-2)
  const tag = Buffer.from('libr', 'ascii');
  const dims = Buffer.concat([ u16le(width), u16le(0), u16le(height), u16le(0) ]);
  const z4   = Buffer.alloc(4, 0);

  // cumulative table
  const cum = [];
  let acc = 0;
  for (let y = 0; y < height - 1; y++) {
    acc += rowSizes[y];
    cum.push(u32le(acc));
  }
  const rowTable = Buffer.concat(cum);

  // Everything up to (but not including) the stream
  const beforeStream = Buffer.concat([fileHdr, dib, palette, tag, dims, z4, rowTable]);

  // bfOffBits is the start of the stream
  const bfOffBits = beforeStream.length;
  // Patch header fields now that we know off & size
  beforeStream.writeUInt32LE(bfOffBits + stream.length, 2);  // bfSize
  beforeStream.writeUInt32LE(bfOffBits, 10);                  // bfOffBits

  // Final file = header/dib/palette/“libr”/table + stream
  return Buffer.concat([beforeStream, stream]);
}

// ---- Pack one *_RLE folder ----
async function packOneFolder(folderPath){
  const folderName = path.basename(folderPath);          // e.g. "NAME_RLE"
  const baseName   = folderName.replace(/_RLE$/i, '');   // "NAME"
  const parent     = path.dirname(folderPath);

  const bmpPath  = path.join(folderPath, `${baseName}.bmp`);
  const maskPath = path.join(folderPath, `${baseName}.mask.bmp`);

  const bmpBuf  = await readFileSafe(bmpPath);
  const maskBuf = await readFileSafe(maskPath);
  if (!bmpBuf) throw new Error(`Missing main BMP at ${bmpPath}`);

  // Parse BMP (produces top-down row array)
  const { width, height, palette, rowsWithPad } = parseIndexedBmp(bmpBuf);
  const rowsNoPad = rowsWithPad.map(r => r.subarray(0, width)); // drop padding bytes

  // Parse mask (optional) for typing only
  let maskRows = null, classMap = null;
  if (maskBuf) {
    ({ maskRows, classMap } = parseMaskBmp(maskBuf, width, height));
  } else {
    // No mask → everything is literal (type 2)
    classMap = new Array(256).fill(2);
  }

  // Encode stream + per-row sizes (needed for the table)
  const { stream, rowSizes } = encodeToCustomRLE(rowsNoPad, maskRows, width, classMap);

  // Build Java-style container ("libr" block + row table before stream)
  const outBuf = buildJavaStyleContainer(width, height, palette, rowSizes, stream);

  const outPath = path.join(parent, `${baseName}.RLE`);
  await fsp.writeFile(outPath, outBuf);

  // Delete the source folder on success
  await fsp.rm(folderPath, { recursive: true, force: true });

  return outPath;
}

// ---- Walk __dirname/output for *_RLE folders ----
async function walkForRLEDirs(root, out){
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const d of entries) {
    const full = path.join(root, d.name);
    if (d.isDirectory()) {
      if (d.name.toLowerCase().endsWith('_rle')) out.push(full);
      await walkForRLEDirs(full, out);
    }
  }
}

async function main(){
  const root = path.join(__dirname, 'output');
  await fsp.mkdir(root, { recursive: true });

  const rleDirs = [];
  await walkForRLEDirs(root, rleDirs);

  if (rleDirs.length === 0) {
    console.log(`No folders ending with "_RLE" found under: ${root}`);
    return;
  }

  console.log(`Found ${rleDirs.length} folder(s) ending with "_RLE". Packing...\n`);
  for (const dir of rleDirs) {
    try {
      const out = await packOneFolder(dir);
      console.log(`OK: ${dir} -> ${out} (folder deleted)`);
    } catch (e) {
      console.error(`FAIL: ${dir} — ${e.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(1);
  });
}
