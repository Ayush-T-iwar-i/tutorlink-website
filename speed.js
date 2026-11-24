
const fs = require('fs');
const path = require('path');

const FONT_URL = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap';
const IMPORT_RE = /@import url\('https:\/\/fonts\.googleapis\.com\/css2\?[^']*'\);\r?\n?/;
const frontend = path.join(__dirname, 'frontend');
const changed = [];

function rewrite(file, fn) {
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after !== before) { fs.writeFileSync(file, after); changed.push(path.relative(__dirname, file)); }
}

// 1) CSS: drop the @import
const styleCss = path.join(frontend, 'css', 'style.css');
rewrite(styleCss, (s) => s.replace(IMPORT_RE, ''));

// 2) HTML: add preconnect + fonts <link> right before the style.css link
for (const name of fs.readdirSync(frontend).filter((f) => f.endsWith('.html'))) {
  rewrite(path.join(frontend, name), (s) => {
    const nl = s.includes('\r\n') ? '\r\n' : '\n';
    const m = s.match(/^([ \t]*)<link rel="stylesheet" href="css\/style\.css[^"]*">/m);
    if (!m || s.includes('fonts.googleapis.com/css2')) return s;
    const ind = m[1];
    const lines = [];
    if (!s.includes('rel="preconnect" href="https://fonts.googleapis.com"')) lines.push('<link rel="preconnect" href="https://fonts.googleapis.com">');
    if (!s.includes('rel="preconnect" href="https://fonts.gstatic.com"')) lines.push('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    lines.push(`<link rel="stylesheet" href="${FONT_URL}">`);
    return s.replace(m[0], lines.map((l) => ind + l).join(nl) + nl + m[0]);
  });
}

// 3) server.js: shorter image cache
const serverJs = path.join(__dirname, 'backend', 'server.js');
rewrite(serverJs, (s) => {
  let out = s.replace("/\\.(woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|ico)$/.test(filePath)", "/\\.(woff2?|ttf|otf|eot)$/.test(filePath)");
  if (out !== s) {
    out = out.replace(/(\r?\n)(\s*)\/\/ Images\/fonts: very long cache/, "$1$2// Fonts: very long cache (file names never change)");
    // images/icons keep the same names when replaced, so they are cached for a week only
    out = out.replace(/(res\.setHeader\('Cache-Control', 'public, max-age=31536000, immutable'\);\r?\n(\s*)\})/, (all, _a, ind) =>
      all + ` else if (/\\.(svg|png|jpg|jpeg|webp|ico)$/.test(filePath)) {\n${ind}  res.setHeader('Cache-Control', 'public, max-age=604800');\n${ind}}`);
  }
  return out;
});

console.log(changed.length ? 'Updated:\n  ' + changed.join('\n  ') : 'Nothing to change (already done).');