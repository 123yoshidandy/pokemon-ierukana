// PokeAPI リポジトリの CSV から js/pokedex.js を生成する開発用スクリプト。
// 使い方: node scripts/generate-pokedex.mjs
// アプリのビルドには不要（生成した js/pokedex.js をそのまま配布する）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv';
const JA_HRKT = 1; // local_language_id: 1 = ja-Hrkt（カタカナ表記）

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchCsv(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const [header, ...rows] = parseCsv(await res.text());
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const [species, names] = await Promise.all([
  fetchCsv('pokemon_species.csv'),
  fetchCsv('pokemon_species_names.csv'),
]);

const genById = new Map(species.map((s) => [Number(s.id), Number(s.generation_id)]));
const entries = names
  .filter((n) => Number(n.local_language_id) === JA_HRKT)
  .map((n) => ({
    no: Number(n.pokemon_species_id),
    name: n.name,
    gen: genById.get(Number(n.pokemon_species_id)),
  }))
  .filter((e) => e.no && e.name && e.gen)
  .sort((a, b) => a.no - b.no);

// 図鑑Noに抜けがないか検査
for (let i = 0; i < entries.length; i++) {
  if (entries[i].no !== i + 1) throw new Error(`図鑑No ${i + 1} が欠落しています`);
}

const lines = entries.map((e) => `{no:${e.no},name:${JSON.stringify(e.name)},gen:${e.gen}}`);
const out = `// generate-pokedex.mjs により自動生成（データ元: PokeAPI）。手動編集しないこと。
const POKEDEX = [
${lines.join(',\n')}
];
`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'js'), { recursive: true });
writeFileSync(join(root, 'js', 'pokedex.js'), out);
console.log(`js/pokedex.js を生成しました: ${entries.length} 匹 (最終世代: ${entries.at(-1).gen})`);
