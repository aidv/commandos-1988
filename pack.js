#!/usr/bin/env node
/**
 * WARGAME.DIR packer (single-file variant: dir tables + file data in one file).
 *
 * Layout per record (44 bytes):
 *  0x00..0x1F (32): name (ASCII, NUL-terminated)
 *  0x20..0x23 (u32): type/flag     -> 0xCDCDCD00=file, 0xCDCDCD01=dir, 0xCDCDCDFF=terminator
 *  0x24..0x27 (u32): size (bytes)  -> files only; dirs=0
 *  0x28..0x2B (u32): pos (offset)  -> files: data offset; dirs: child table offset (within this file)
 *
 * Strategy:
 *  1) Scan INPUT_DIR -> build tree of directories & files
 *  2) Pass A: compute table sizes and assign a tableOffset for each directory
 *  3) Pass B: assign data offsets for all files after the directory area (4-byte aligned)
 *  4) Write: emit all tables at their tableOffset, then emit file payloads at their data offsets
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

/* --------------------- EDIT THESE --------------------- */
const INPUT_DIR   = __dirname + '/output/';   // <- folder to pack
const OUTPUT_FILE = __dirname + "/WARGAME_REPACKED.DIR";  // <- output .DIR path
/* ------------------------------------------------------ */


const TYPE_FILE = 0xCDCDCD00 >>> 0;
const TYPE_DIR  = 0xCDCDCD01 >>> 0;
const TYPE_FIN  = 0xCDCDCDFF >>> 0;
const REC_SIZE = 44;
const ALIGN = 4;

const U32 = n => (n >>> 0);
const alignUp = (v, a) => (v + ((a - (v % a)) % a)) >>> 0;

const padName32 = (name) => {
  const sanitized = name.replace(/[<>:"|?*\x00-\x1F]/g, "_").replace(/\.\./g, "_").slice(0, 31);
  const b = Buffer.from(sanitized, "latin1");
  const out = Buffer.alloc(32, 0);
  b.copy(out, 0, 0, Math.min(b.length, 31));
  return out;
};
const recBuf = (name, type, size, pos) => {
  const b = Buffer.alloc(REC_SIZE);
  padName32(name.toUpperCase()).copy(b, 0);
  b.writeUInt32LE(U32(type), 32);
  b.writeUInt32LE(U32(size), 36);
  b.writeUInt32LE(U32(pos), 40);
  return b;
};

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }

async function scanTree(root) {
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a,b) => a.name.localeCompare(b.name, "en", {sensitivity:"base"}));
    const kids = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory())       kids.push({ name: e.name, isDir: true,  children: (await walk(full)).children });
      else if (e.isFile()) {
        const st = await fsp.stat(full);
        kids.push({ name: e.name, isDir: false, filePath: full, size: st.size >>> 0 });
      }
    }
    return { name: ".", isDir: true, children: kids };
  }
  const t = await walk(root);
  t.name = ".";
  return t;
}

function assignTableOffsets(root) {
  // Preorder list of all directory nodes
  const dirs = [];
  (function collect(n){ if (n.isDir){ dirs.push(n); for (const c of n.children) if (c.isDir) collect(c); } })(root);

  let cursor = 0;
  for (const d of dirs) {
    d.tableOffset = cursor;                              // absolute offset in .DIR
    const tableBytes = REC_SIZE * (d.children.length + 1); // + terminator
    cursor = (cursor + tableBytes) >>> 0;
  }
  const dirAreaSize = cursor >>> 0;                      // end of last table
  return { dirs, dirAreaSize };
}

function assignFileOffsets(root, dataBase) {
  let cursor = dataBase >>> 0;
  (function visit(d){
    // files first, to match table order
    for (const c of d.children) if (!c.isDir) {
      cursor = alignUp(cursor, ALIGN);
      c.dataOffset = cursor;
      cursor = (cursor + c.size) >>> 0;
    }
    for (const c of d.children) if (c.isDir) visit(c);
  })(root);
  return cursor >>> 0;
}

function verifyNoOverlap(root, dirAreaEnd, dataBase) {
  // All file data must be >= dataBase and >= dirAreaEnd
  (function visit(d){
    for (const c of d.children) {
      if (!c.isDir) {
        if (c.dataOffset < dataBase || c.dataOffset < dirAreaEnd) {
          throw new Error(`File offset overlap: "${c.name}" @ ${c.dataOffset} < dataBase ${dataBase} / dirAreaEnd ${dirAreaEnd}`);
        }
      }
    }
    for (const c of d.children) if (c.isDir) visit(c);
  })(root);
}

async function writeTables(fd, root) {
  async function writeDir(d) {
    let p = d.tableOffset;
    // siblings
    for (const c of d.children) {
      if (c.isDir) await fd.write(recBuf(c.name, TYPE_DIR, 0, c.tableOffset), 0, REC_SIZE, p);
      else         await fd.write(recBuf(c.name, TYPE_FILE, c.size, c.dataOffset), 0, REC_SIZE, p);
      p += REC_SIZE;
    }
    // terminator
    await fd.write(recBuf("DIRECTOR.FIN", TYPE_FIN, 0xFFFFFFFF, 0xFFFFFFFF), 0, REC_SIZE, p);
    // recurse
    for (const c of d.children) if (c.isDir) await writeDir(c);
  }
  await writeDir(root);
}

async function writeData(fd, root) {
  async function copyFile(src, fd, off) {
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src);
      let pos = off;
      rs.on("data", async chunk => {
        rs.pause();
        try { await fd.write(chunk, 0, chunk.length, pos); pos += chunk.length; rs.resume(); }
        catch(e){ reject(e); }
      });
      rs.on("end", resolve);
      rs.on("error", reject);
    });
  }
  async function visit(d) {
    for (const c of d.children) if (!c.isDir) await copyFile(c.filePath, fd, c.dataOffset);
    for (const c of d.children) if (c.isDir)  await visit(c);
  }
  await visit(root);
}

(async function main(){
  try {
    console.log("[*] Scanning:", INPUT_DIR);
    const tree = await scanTree(INPUT_DIR);

    // 1) Tables
    const { dirAreaSize } = assignTableOffsets(tree);
    const dataBase = alignUp(dirAreaSize, ALIGN);

    // 2) File payload offsets
    const endOfData = assignFileOffsets(tree, dataBase);

    // 3) Sanity: no file offset inside dir area
    verifyNoOverlap(tree, dirAreaSize, dataBase);

    // 4) Create/truncate output to full size
    await ensureDir(path.dirname(OUTPUT_FILE));
    const fd = await fsp.open(OUTPUT_FILE, "w+");
    await fd.truncate(endOfData);

    // 5) Write tables then data
    await writeTables(fd, tree);
    await writeData(fd, tree);
    await fd.close();

    console.log(`[*] OK: wrote ${OUTPUT_FILE}`);
    console.log(`    dirAreaSize=${dirAreaSize}, dataBase=${dataBase}, endOfData=${endOfData}`);
  } catch (e) {
    console.error("ERROR:", e.message || e); process.exit(1);
  }
})();