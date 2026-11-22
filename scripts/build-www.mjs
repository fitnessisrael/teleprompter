// מעתיק את קבצי האתר לתיקיית www (בלי vendor/ffmpeg הכבד, שלא נחוץ באפליקציה הנייטיבית)
import { cpSync, mkdirSync, rmSync } from 'node:fs';
rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
for (const f of ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest']) cpSync(f, `www/${f}`);
cpSync('icons', 'www/icons', { recursive: true });
console.log('www ready');
