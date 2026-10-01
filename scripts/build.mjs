// Refreshes each plugin's manifest hash and copies the plugins into dist/.
// Kettu only re-downloads a plugin's code when the manifest hash changes,
// so run this (npm run build) after editing any plugin's index.js.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginsDir = "plugins";
const distDir = "dist";

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir);

const built = [];
for (const id of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, id);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const main = manifest.main ?? "index.js";
    const hash = createHash("sha256").update(readFileSync(join(dir, main))).digest("hex");

    if (manifest.hash !== hash) {
        manifest.hash = hash;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        console.log(`${id}: hash updated -> ${hash}`);
    } else {
        console.log(`${id}: up to date`);
    }

    cpSync(dir, join(distDir, "plugins", id), { recursive: true });
    built.push({ id, name: manifest.name, description: manifest.description });
}

const themes = [];
if (existsSync("themes")) {
    cpSync("themes", join(distDir, "themes"), { recursive: true });
    for (const file of readdirSync("themes").filter(f => f.endsWith(".json")).sort()) {
        const theme = JSON.parse(readFileSync(join("themes", file), "utf8"));
        themes.push({ path: `themes/${file}`, name: theme.name, description: theme.description });
    }
}

const items = [
    ...built.map(p => ({ ...p, path: `plugins/${p.id}/` })),
    ...themes.map(t => ({ ...t, name: `${t.name} (theme)` }))
]
    .map(p => `<li><b>${p.name}</b> - ${p.description}<br><code class="url" data-path="${p.path}"></code></li>`)
    .join("\n");
writeFileSync(join(distDir, "index.html"), `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kettu Plugins</title>
<style>body{font-family:monospace;background:#0d0d0d;color:#33ff66;padding:16px;max-width:720px;margin:auto}li{margin:12px 0}code{color:#fff}</style>
<h1>$ ls plugins/</h1>
<p>Copy a URL below into Kettu: Settings &rarr; Plugins (or Themes) &rarr; + (install).</p>
<ul>
${items}
</ul>
<script>for (const el of document.querySelectorAll(".url")) el.textContent = new URL(el.dataset.path, location.href).href;</script>
`);

console.log(`Built ${built.length} plugin(s) and ${themes.length} theme(s) into ${distDir}/`);
