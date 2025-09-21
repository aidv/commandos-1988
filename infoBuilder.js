const fs = require('fs');
const path = require('path');

// Helper to read BMP width/height from header
function getBmpDimensions(filePath) {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(26); // Enough for header
    fs.readSync(fd, buffer, 0, 26, 0);
    fs.closeSync(fd);

    // BMP width/height are at offset 18 and 22, little-endian 4 bytes
    const width = buffer.readUInt32LE(18);
    const height = buffer.readUInt32LE(22);
    return { width, height };
}

// Recursively find BMP files
function findBmpFiles(dir, result = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findBmpFiles(fullPath, result);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.bmp')) {
            result.push(fullPath);
        }
    }
    return result;
}

const outputDir = path.join(__dirname, 'output');
const bmpFiles = findBmpFiles(outputDir);

const info = {};
for (const bmpPath of bmpFiles) {
    const relPath = path.relative(__dirname, bmpPath).split('\\').join('/');
    try {
        info[relPath] = getBmpDimensions(bmpPath);
    } catch (e) {
        info[relPath] = { error: e.message };
    }
}

fs.writeFileSync(path.join(__dirname, 'info.json'), JSON.stringify(info, null, 2));
console.log('Saved info.json');