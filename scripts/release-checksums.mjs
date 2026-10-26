import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = 'src-tauri/target/release/bundle';
let count = 0;
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const name of await readdir(path.join(root, entry.name))) {
    if (!/\.(dmg|app\.zip|AppImage|deb|rpm|exe|msi)$/.test(name)) continue;
    const file = path.join(root, entry.name, name);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    await writeFile(`${file}.sha256`, `${hash.digest('hex')}  ${name}\n`);
    count++;
  }
}
if (!count) throw new Error('No installers found for checksum generation');
console.log(`Generated SHA-256 checksums for ${count} installers`);
