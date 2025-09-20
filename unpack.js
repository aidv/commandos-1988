console.log('Commandos 2025')

/**
 * Extractor for WARGAME.DIR when both directory + data live in the same file.
 *
 * Record layout (44 bytes, little-endian):
 *   0x00..0x1F (32) : name (ASCII, NUL-terminated)
 *   0x20..0x23 (u32): type/flag -> low byte: 0x00=file, 0x01=dir, 0xFF=terminator ("DIRECTOR.FIN")
 *   0x24..0x27 (u32): size      -> for files: payload length; for dirs: usually 0
 *   0x28..0x2B (u32): pos       -> files: offset in THIS .DIR to payload; dirs: offset in THIS .DIR to child table
 */


const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

/* ----------------------------- EDIT THESE ----------------------------- */
const DIR_PATH = __dirname + '/WARGAME.DIR';  // <- set to your WARGAME.DIR
const OUT_DIR  = __dirname + '/output/';    // <- where to write files
/* --------------------------------------------------------------------- */

function u32le(buf, off) {
  // Unsigned 32-bit LE
  return buf.readUInt32LE(off) >>> 0;
}

function readString32(buf, off) {
  const slice = buf.subarray(off, off + 32);
  let end = slice.indexOf(0x00);
  if (end < 0) end = 32;
  return Buffer.from(slice.subarray(0, end)).toString("latin1").replace(/\s+$/g, "");
}

function sanitizeName(name, isDir = false) {
  // Keep DOS/Windows-friendly, avoid traversal
  let s = name.replace(/[<>:"|?*\x00-\x1F]/g, "_").replace(/\.\./g, "_");
  if (!isDir) s = s.replace(/[\\/]/g, "_");
  if (!s) s = "_";
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

function readRecord(buf, off) {
  if (off < 0 || off + 44 > buf.length) return null;
  const name = readString32(buf, off);
  if (!name) return null;
  const type = u32le(buf, off + 32);
  const size = u32le(buf, off + 36);
  const pos  = u32le(buf, off + 40);
  return { off, name, type, size, pos };
}

function isTerminator(rec) {
  const low = rec.type & 0xff;
  return rec.name === "DIRECTOR.FIN" || low === 0xff || rec.size === 0xffffffff || rec.pos === 0xffffffff;
}

const isDir  = (rec) => (rec.type & 0xff) === 0x01;
const isFile = (rec) => (rec.type & 0xff) === 0x00;

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function writeSlice(dirBuf, outPath, start, size) {
  if (start + size > dirBuf.length) {
    throw new Error(`slice out of range: ${start}+${size} > ${dirBuf.length}`);
  }
  await ensureDir(path.dirname(outPath));
  await fsp.writeFile(outPath, dirBuf.subarray(start, start + size));
}

async function walkTable(dirBuf, tableStart, outRoot, relPath, visited, stats) {
  if (visited.has(tableStart)) return; // avoid loops
  visited.add(tableStart);

  let off = tableStart >>> 0;
  for (;;) {
    const rec = readRecord(dirBuf, off);
    if (!rec) break;

    if (isTerminator(rec)) {
      // console.log(`[END] ${rec.name} at 0x${off.toString(16)}`);
      break;
    }

    if (isDir(rec)) {
      const dname = sanitizeName(rec.name, true);
      const nextRel = path.join(relPath, dname);
      await ensureDir(path.join(outRoot, nextRel));
      stats.dirs++;
      await walkTable(dirBuf, rec.pos, outRoot, nextRel, visited, stats);
    } else if (isFile(rec)) {
      const fname = sanitizeName(rec.name, false);
      const outPath = path.join(outRoot, relPath, fname);
      try {
        await writeSlice(dirBuf, outPath, rec.pos, rec.size);
        stats.files++;
      } catch (e) {
        stats.errors++;
        console.warn(`Skip ${path.join(relPath, rec.name)} @${rec.pos}+${rec.size}: ${e.message}`);
      }
    } else {
      // Unknown type — skip safely
      // console.warn(`Unknown type 0x${(rec.type & 0xff).toString(16)} at 0x${off.toString(16)} (${rec.name})`);
    }

    off += 44; // next sibling record in this table
  }
}

(async function main() {
  try {
    console.log(`Reading ${DIR_PATH} …`);
    const dirBuf = await fsp.readFile(DIR_PATH); // ~50–60 MiB OK in memory
    await ensureDir(OUT_DIR);

    const visited = new Set();
    const stats = { files: 0, dirs: 0, errors: 0 };

    console.log(`Walking table at 0x00000000 …`);
    await walkTable(dirBuf, 0, OUT_DIR, ".", visited, stats);

    console.log(`Done. Extracted ${stats.files} files, created ${stats.dirs} folders, ${stats.errors} errors.`);
    console.log(`Output: ${OUT_DIR}`);
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
})();