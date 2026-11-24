// מעתיק את קבצי האתר לתיקיית www לאפליקציה הנייטיבית.
// באפליקציה הסקריפט רץ כסקריפט רגיל (לא module) עטוף בפונקציה אסינכרונית,
// כי טעינת module דרך הסכמה capacitor:// יכולה להיכשל בשקט ב-WebView של אפל.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
for (const f of ['styles.css', 'manifest.webmanifest']) cpSync(f, `www/${f}`);
cpSync('icons', 'www/icons', { recursive: true });

const js = readFileSync('app.js', 'utf8');
writeFileSync('www/app.js',
  `(async () => {\ntry { window.__bootOk && window.__bootOk(); } catch (e) {}\n${js}\n})().catch((e) => { window.__showErr && window.__showErr('BOOT ' + (e && (e.stack || e.message) || e)); });\n`);

const boot = `<script>(function(){var b;function show(m){if(!b){b=document.createElement('pre');b.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;margin:0;padding:8px 10px;max-height:45vh;overflow:auto;background:rgba(140,0,0,.94);color:#fff;font:12px/1.4 monospace;white-space:pre-wrap;direction:ltr;text-align:left';document.body.appendChild(b);}b.textContent+=m+'\\n';}
window.__showErr=show;window.__bootOk=function(){if(b&&b.textContent==='TP loading...\\n'){b.remove();b=null;}};
window.addEventListener('error',function(e){show('ERR '+e.message+' '+String(e.filename||'').split('/').pop()+':'+e.lineno)});
window.addEventListener('unhandledrejection',function(e){show('REJ '+(e.reason&&(e.reason.message||e.reason)))});show('TP loading...');})();</script>\n`;
let html = readFileSync('index.html', 'utf8');
if (!html.includes('<script type="module" src="app.js"></script>')) throw new Error('script tag not found');
html = html.replace('<script type="module" src="app.js"></script>', boot + '<script src="app.js"></script>');
writeFileSync('www/index.html', html);
console.log('www ready');
