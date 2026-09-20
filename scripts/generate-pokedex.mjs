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

const [species, names, pokemon, pokemonTypes, typeNames] = await Promise.all([
  fetchCsv('pokemon_species.csv'),
  fetchCsv('pokemon_species_names.csv'),
  fetchCsv('pokemon.csv'),
  fetchCsv('pokemon_types.csv'),
  fetchCsv('type_names.csv'),
]);

const genById = new Map(species.map((s) => [Number(s.id), Number(s.generation_id)]));

// タイプは種ではなくフォルムに付くため、種ごとの基本フォルム（is_default=1）のタイプを採用する
const defaultFormBySpecies = new Map(
  pokemon.filter((p) => Number(p.is_default) === 1).map((p) => [Number(p.species_id), Number(p.id)])
);
const typeNameById = new Map(
  typeNames.filter((t) => Number(t.local_language_id) === JA_HRKT).map((t) => [Number(t.type_id), t.name])
);
const typesByPokemon = new Map(); // pokemon_id -> [タイプ名]（slot 順）
for (const t of pokemonTypes.sort((a, b) => Number(a.slot) - Number(b.slot))) {
  const pid = Number(t.pokemon_id);
  if (!typesByPokemon.has(pid)) typesByPokemon.set(pid, []);
  typesByPokemon.get(pid).push(typeNameById.get(Number(t.type_id)));
}

const entries = names
  .filter((n) => Number(n.local_language_id) === JA_HRKT)
  .map((n) => {
    const no = Number(n.pokemon_species_id);
    return {
      no,
      name: n.name,
      gen: genById.get(no),
      types: typesByPokemon.get(defaultFormBySpecies.get(no)) || [],
    };
  })
  .filter((e) => e.no && e.name && e.gen)
  .sort((a, b) => a.no - b.no);

// 図鑑Noに抜けがないか、タイプが 1〜2 個解決できているかを検査
for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  if (e.no !== i + 1) throw new Error(`図鑑No ${i + 1} が欠落しています`);
  if (e.types.length < 1 || e.types.length > 2 || e.types.some((t) => !t)) {
    throw new Error(`No.${e.no} ${e.name} のタイプを解決できません: ${JSON.stringify(e.types)}`);
  }
}

const lines = entries.map(
  (e) => `{no:${e.no},name:${JSON.stringify(e.name)},gen:${e.gen},types:${JSON.stringify(e.types)}}`
);
const out = `// generate-pokedex.mjs により自動生成（データ元: PokeAPI）。手動編集しないこと。
const POKEDEX = [
${lines.join(',\n')}
];
`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'js'), { recursive: true });
writeFileSync(join(root, 'js', 'pokedex.js'), out);
console.log(`js/pokedex.js を生成しました: ${entries.length} 匹 (最終世代: ${entries.at(-1).gen})`);
