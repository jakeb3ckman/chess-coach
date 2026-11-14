// Build the static site into dist/:
//   node build.mjs [--cards path/to/cards.json] [--serve]
// The card file normally comes from `python -m coach build --app-out`.
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const args = process.argv.slice(2);
const serve = args.includes('--serve');
const cardsArg = args.includes('--cards') ? args[args.indexOf('--cards') + 1] : null;

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'data'), { recursive: true });

// CSS: chessground's own board and piece styles, then the app's.
const cg = join(here, 'node_modules/@lichess-org/chessground/assets');
const css = ['chessground.base.css', 'chessground.brown.css', 'chessground.cburnett.css']
  .map((f) => readFileSync(join(cg, f), 'utf8'))
  .concat(readFileSync(join(here, 'src/app.css'), 'utf8'))
  .join('\n');
writeFileSync(join(dist, 'app.css'), css);

const opts = {
  entryPoints: [join(here, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  outfile: join(dist, 'app.js'),
  minify: !serve,
  sourcemap: serve,
  legalComments: 'eof',
  define: { BUILD_ID: '"dev"' },
};

if (serve) {
  finish('dev');
  const ctx = await context(opts);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: Number(process.env.PORT || 8000) });
  console.log(`serving http://localhost:${port}/`);
} else {
  // Build once to hash the output, then stamp the hash in as the version.
  await build(opts);
  const id = createHash('sha256').update(readFileSync(join(dist, 'app.js'))).update(css).digest('hex').slice(0, 10);
  await build({ ...opts, define: { BUILD_ID: JSON.stringify(id) } });
  finish(id);
  console.log(`built dist/ (version ${id})`);
}

function finish(id) {
  for (const f of readdirSync(join(here, 'public'))) {
    const src = join(here, 'public', f);
    if (/\.(html|js|webmanifest)$/.test(f)) {
      writeFileSync(join(dist, f), readFileSync(src, 'utf8').replaceAll('__BUILD_ID__', id));
    } else {
      cpSync(src, join(dist, f));
    }
  }
  const cards = cardsArg ?? join(here, '..', 'data', 'derived', 'app-cards.json');
  if (existsSync(cards)) cpSync(cards, join(dist, 'data', 'cards.json'));
  else console.warn(`no card file at ${cards}; run: uv run python -m coach build --app-out data/derived/app-cards.json`);
  // Every published HTML page must carry noindex (spec section 2).
  for (const f of readdirSync(dist).filter((f) => f.endsWith('.html'))) {
    if (!readFileSync(join(dist, f), 'utf8').includes('<meta name="robots" content="noindex, nofollow">')) {
      throw new Error(`${f} is missing the noindex meta tag`);
    }
  }
}
