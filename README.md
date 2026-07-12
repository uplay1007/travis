<h1 align="center">🗺️ TraVis - Trace and Visualize</h1>

<p align="center">
  <b>Paste a schema. Get a map.</b><br/>
  Turn SQL, Prisma, Django, TypeORM or SQLAlchemy into an interactive diagram you can
  drag, group, and reshape — right in the browser.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=black" alt="React 18" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/scope-schema--only-10b981" alt="Schema-only" />
</p>

<!-- ▶ add a screenshot or GIF of the canvas here — it sells the whole thing -->

---

A relational schema usually lives as text — DDL dumps, ORM models, migration files.
Holding 30 tables and their foreign keys in your head from that is painful.
**TraVis turns the text into a map you can actually read** — for designing a new
database, onboarding onto a legacy one, or arguing about a model with your team.

> It maps the **structure** — tables, columns, keys, relationships. Not the row data.

## ✨ What it does

- **⚡ Import anything** — SQL · Prisma · TypeORM · Django · SQLAlchemy · JSON. Format is auto-detected.
- **🧭 Auto-layout** — ELK arranges even a 30-table schema into a readable map on first load, with per-column ports so foreign keys land on the exact row they join instead of bunching at one point. Or hit **Organize** anytime.
- **🔦 Trace relationships** — click a table to spotlight everything it's linked to; hover an edge to light up the exact columns it joins.
- **🎯 Focused views** — `Shift`-click to hand-pick tables, `⌥`-click to grab a table and its private satellites, then save them as named **layouts** — each with its own positions *and* detail level.
- **✏️ Edit live** — a visual table editor **and** a two-pane DSL editor that validates as you type: bad types, broken relations, or Cyrillic names underline the culprit and freeze the canvas until you fix it.
- **🏷️ Table roles** — tag a table's architectural role (reference, master, transactional, link, dimension, fact) for a quick read on how a schema is shaped.
- **☁️ Cloud saves** — schemas (layouts and all) sync across devices behind auth + row-level security.
- **↔️ Round-trip export** — write back to SQL DDL or a clean, structured JSON.
- **📐 draw.io export** — export the whole schema at once, one switchable page per layout (plus "All tables"), as native draw.io table shapes ready to drop into docs or wikis.

## 🚀 Quick start

```bash
git clone https://github.com/uplay1007/travis.git
cd travis
npm install
npm run dev
```

Then drop in a schema file — or paste one straight into the box.

## 🔌 Formats

| Format | Import | Export |
|--------|:------:|:------:|
| SQL (PostgreSQL / MySQL) | ✅ | ✅ |
| JSON (structured) | ✅ | ✅ |
| Prisma schema | ✅ | — |
| TypeORM entities | ✅ | — |
| Django models | ✅ | — |
| SQLAlchemy models | ✅ | — |
| draw.io diagram | — | ✅ |

## 🛠 Built with

[React 18](https://react.dev/) · [React Flow](https://reactflow.dev/) (canvas) ·
[ELK.js](https://github.com/kieler/elkjs) (layout) · [CodeMirror](https://codemirror.net/) (DSL editor) ·
[Supabase](https://supabase.com/) (auth + saves) · [Vite](https://vitejs.dev/)

---

<p align="center"><sub>Structure, not data — no row contents, live connections, or migrations.</sub></p>
