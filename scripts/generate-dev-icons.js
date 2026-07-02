const fs = require('fs');
const path = require('path');

const srcLogo = 'C:\\Users\\ADMIN\\.gemini\\antigravity-ide\\brain\\6231ab75-b2f4-454a-97c4-ae991148fe85\\zalo_auto_logo_1782966678000.png';
const targetDir = path.resolve(__dirname, '../resources/icons');

// Create directory if not exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// 16x16 red dot PNG base64
const overlayDotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZ0lEQVR42mP8z8AARjDwAlmGgZUBKGAEYgYgZgRiRiBmA2JGIGYCYhYgZoKqYAJiFiBmAWImIGYCYg4g5gBiDiDmAGIOIOYAYg4g5gBiDiDmAGIOIOYAYg4g5gBiDiDmAGIOIOYAYg4g5gAFnAMR4WkqCgAAAABJRU5ErkJggg==';

try {
  if (fs.existsSync(srcLogo)) {
    const pngData = fs.readFileSync(srcLogo);

    // Copy PNG targets
    fs.writeFileSync(path.join(targetDir, 'icon.png'), pngData);
    fs.writeFileSync(path.join(targetDir, 'icon_128.png'), pngData);
    fs.writeFileSync(path.join(targetDir, 'icon_dot.png'), pngData);
    fs.writeFileSync(path.join(targetDir, 'icon_dot_128.png'), pngData);
    console.log('✅ Generated PNG icons');

    // Create valid ICO file wrapping the PNG
    const icoHeader = Buffer.alloc(22);
    // ICO Header
    icoHeader.writeUInt16LE(0, 0); // Reserved
    icoHeader.writeUInt16LE(1, 2); // Image type (1 = ICO)
    icoHeader.writeUInt16LE(1, 4); // Number of images (1)

    // Directory Entry
    icoHeader.writeUInt8(0, 6); // Width (0 means 256)
    icoHeader.writeUInt8(0, 7); // Height (0 means 256)
    icoHeader.writeUInt8(0, 8); // Color palette
    icoHeader.writeUInt8(0, 9); // Reserved
    icoHeader.writeUInt16LE(1, 10); // Color planes
    icoHeader.writeUInt16LE(32, 12); // Bits per pixel
    icoHeader.writeUInt32LE(pngData.length, 14); // Image data size
    icoHeader.writeUInt32LE(22, 18); // Offset of image data

    const icoData = Buffer.concat([icoHeader, pngData]);
    fs.writeFileSync(path.join(targetDir, 'icon.ico'), icoData);
    console.log('✅ Generated valid icon.ico wrapping the PNG');

  } else {
    console.error('❌ Source logo not found at:', srcLogo);
  }

  // Write overlay_dot.png
  fs.writeFileSync(path.join(targetDir, 'overlay_dot.png'), Buffer.from(overlayDotBase64, 'base64'));
  console.log('✅ Generated overlay_dot.png');

} catch (err) {
  console.error('❌ Error copying/generating icons:', err.message);
}
