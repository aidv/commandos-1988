const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const bmp = require('bmp-js');
const quantize = require('quantize');
const { spawnSync } = require('child_process');

var infoDatabase = JSON.parse(fs.readFileSync(__dirname + '/info.json'))


async function findBmpFiles(rootDir) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Skip unreadable directories but keep going
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && /\.bmp$/i.test(entry.name)) {
        results.push('output' + path.resolve(fullPath).split('\\').join('/').replace(rootDir, ''));
      }
    }
  }

  await walk(rootDir);
  return results;
}

function getBmpInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');

  try {
    // Read enough for file header (14) + DIB header (at least 12–40 bytes)
    const buf = Buffer.alloc(128);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead < 26) throw new Error('File too small to be a valid BMP');

    // Validate signature "BM"
    if (buf[0] !== 0x42 || buf[1] !== 0x4D) {
      throw new Error('Not a BMP (missing BM signature)');
    }

    // DIB header size at offset 14 (0x0E), uint32 LE
    const dibSize = buf.readUInt32LE(14);

    let width, height, bitDepth;

    if (dibSize >= 40 && bytesRead >= 14 + 40) {
      // BITMAPINFOHEADER (40) or later (V2..V5): use 32-bit width/height
      width = buf.readInt32LE(18);   // offset 0x12 from file start
      height = buf.readInt32LE(22);  // offset 0x16
      // color planes at 26 (must be 1), bit count at 28
      bitDepth = buf.readUInt16LE(28);
    } else if (dibSize === 12 && bytesRead >= 14 + 12) {
      // OS/2 BITMAPCOREHEADER: width/height are 16-bit unsigned
      width = buf.readUInt16LE(18);
      height = buf.readUInt16LE(20);
      bitDepth = buf.readUInt16LE(24);
    } else {
      throw new Error(`Unsupported or truncated DIB header (size=${dibSize})`);
    }

    // BMP can store negative height (top-down). Return absolute pixels.
    const absHeight = Math.abs(height);

    return { width, height: absHeight, bitDepth };
  } finally {
    fs.closeSync(fd);
  }
}

var mismatchesWithDatabase = fileInfo =>{
    var dbEntry = infoDatabase[fileInfo.path]
    if (dbEntry.width !== fileInfo.width || dbEntry.height !== fileInfo.height) return dbEntry
}





async function resizeBmp(srcPath, {
  width,
  height,
  destPath,
  fit = 'fill',
  kernel = 'lanczos3'
}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('width and height must be positive numbers');
  }
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Source not found: ${srcPath}`);
  }

  // 1) Read & decode BMP (works even if your sharp/libvips lacks BMP support)
  const inputBuf = await fs.promises.readFile(srcPath);
  let decoded;
  try {
    decoded = bmp.decode(inputBuf); // { data: RGBA Buffer, width, height }
  } catch (e) {
    throw new Error(`Failed to decode BMP: ${e.message}`);
  }

  const srcWidth = decoded.width;
  const srcHeight = decoded.height;
  const channels = 4; // RGBA from bmp-js

  // Map kernel to sharp enum
  const kernelMap = {
    nearest: sharp.kernel.nearest,
    cubic: sharp.kernel.cubic,
    mitchell: sharp.kernel.mitchell,
    lanczos2: sharp.kernel.lanczos2,
    lanczos3: sharp.kernel.lanczos3
  };
  const sharpKernel = kernelMap[kernel] ?? sharp.kernel.lanczos3;

  // 2) Resize raw pixels with sharp
  const { data: resizedRGBA, info } = await sharp(decoded.data, {
    raw: { width: srcWidth, height: srcHeight, channels },
    failOn: 'none',
    limitInputPixels: false,
    sequentialRead: true
  })
    .resize({ width, height, fit, kernel: sharpKernel })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 3) Re-encode to BMP (24/32-bit as produced by bmp-js)
  const encoded = bmp.encode({
    data: resizedRGBA,        // RGBA buffer
    width: info.width,
    height: info.height
  });

  // 4) Write out (atomic-ish)
  const outPath = destPath || srcPath;
  const tmp = outPath + '.tmp';
  await fs.promises.writeFile(tmp, encoded.data);
  await fs.promises.rename(tmp, outPath);

  return { outPath, from: { width: srcWidth, height: srcHeight }, to: { width: info.width, height: info.height } };
}





function bmp24to8WithFfmpeg(srcPath, destPath, opts = {}) {
  const { log = true } = opts;

  if (!fs.existsSync(srcPath)) {
    throw new Error(`Source not found: ${srcPath}`);
  }
  const ffmpeg = 'ffmpeg';

  // quick availability check
  const probe = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    throw new Error('FFmpeg not found in PATH. Please install ffmpeg and try again.');
  }

  // temp palette file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmp-pal8-'));
  const palettePath = path.join(tmpDir, 'palette.png');

  // 1) Generate palette (palettegen)
  {
    const args = [
      '-y',
      '-v', 'error',
      '-i', srcPath,
      // basic palettegen; you can add options like max_colors=256, stats_mode=full if needed
      '-vf', 'palettegen=stats_mode=full',
      palettePath
    ];
    //if (log) console.log(`[ffmpeg] ${args.join(' ')}`);
    const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
    if (r.status !== 0) {
      safeCleanup(tmpDir);
      throw new Error(`ffmpeg palettegen failed with exit code ${r.status}`);
    }
  }

  // 2) Apply palette (paletteuse) -> 8-bit paletted BMP
  {
    const args = [
      '-y',
      '-v', 'error',
      '-i', srcPath,
      '-i', palettePath,
      '-filter_complex', '[0:v][1:v]paletteuse=new=1',
      destPath
    ];
    //if (log) console.log(`[ffmpeg] ${args.join(' ')}`);
    const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
    if (r.status !== 0) {
      safeCleanup(tmpDir);
      throw new Error(`ffmpeg paletteuse failed with exit code ${r.status}`);
    }
  }

  // cleanup
  safeCleanup(tmpDir);
  //if (log) console.log(`Wrote 8-bit BMP → ${destPath}`);
}

function safeCleanup(dir) {
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      fs.rmdirSync(dir);
    }
  } catch (_) { /* ignore */ }
}

var processBMP = async src => {
    var fullPath = __dirname + '/' + src
    var info = getBmpInfo(fullPath)

    var dbEntry = mismatchesWithDatabase({...{path: src, ...info}})
    if (dbEntry){
        var tmpResized = __dirname + '/tmpResized.bmp'
        await resizeBmp(src, {width: dbEntry.width, height: dbEntry.height, destPath: tmpResized})
        

        var tmpQuantized = __dirname + '/tmpQuantized.bmp'
        await bmp24to8WithFfmpeg(tmpResized, tmpQuantized);

        fs.rmSync(fullPath)
        fs.rmSync(tmpResized)
        //fs.rmSync(tmpQuantized)
        fs.renameSync(tmpQuantized, fullPath)
    }
}


var main = async ()=>{
    var bmpList = await findBmpFiles((__dirname + '/output').split('\\').join('/'))
    
    for (var i in bmpList){
        await processBMP(bmpList[i])
    }
}

main()