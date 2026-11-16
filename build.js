// Builds:
//   dist/capability-check.js  – the three source files in one script, to serve via jsDelivr
//   dist/test-form.html       – self-contained test form (SheetJS + scripts inlined)
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

const SOURCES = ['src/vin-parser.js', 'src/email-check.js', 'src/form-controller.js'];

const banner = `/*! Motorq Capability Check v${pkg.version} | Brightscout */\n`;
const bundle = banner + SOURCES.map((f) => `/* ${f} */\n${read(f)}`).join('\n');

const inline = (code) => code.replace(/<\/script/gi, '<\\/script');
const testForm = read('test/test-form.template.html')
  .replace('/*__XLSX__*/', () => inline(read('node_modules/xlsx/dist/xlsx.full.min.js')))
  .replace('/*__VIN_PARSER__*/', () => inline(read('src/vin-parser.js')))
  .replace('/*__EMAIL_CHECK__*/', () => inline(read('src/email-check.js')))
  .replace('/*__FORM_CONTROLLER__*/', () => inline(read('src/form-controller.js')));

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const [name, content] of [['capability-check.js', bundle], ['test-form.html', testForm]]) {
  fs.writeFileSync(path.join(root, 'dist', name), content);
  console.log(`dist/${name}  ${(content.length / 1024).toFixed(0)} KB`);
}
