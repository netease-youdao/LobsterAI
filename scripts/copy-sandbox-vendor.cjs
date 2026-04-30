const fs = require('fs');
const path = require('path');

const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const copies = [
  ['node_modules/react/umd/react.production.min.js', 'react.production.min.js'],
  ['node_modules/react-dom/umd/react-dom.production.min.js', 'react-dom.production.min.js'],
  ['node_modules/@babel/standalone/babel.min.js', 'babel.min.js'],
];

for (const [src, dest] of copies) {
  const srcPath = path.join(__dirname, '..', src);
  const destPath = path.join(vendorDir, dest);
  fs.copyFileSync(srcPath, destPath);
  const size = (fs.statSync(destPath).size / 1024).toFixed(1);
  console.log(`Copied ${src} -> public/vendor/${dest} (${size} KB)`);
}
