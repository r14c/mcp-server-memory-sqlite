// Server-rendered view layer. Everything interpolated into a document comes
// through escapeHtml, including attribute values, so a graph value can never
// close a tag or break out of a quoted attribute.

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root {
  color-scheme: light dark;
}
* {
  box-sizing: border-box;
}
html,
body {
  height: 100%;
}
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.45;
}
header {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #d0d0d0;
}
h1 {
  margin: 0;
  font-size: 1.1rem;
}
h2 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
h3 {
  font-size: 0.9rem;
  margin: 1rem 0 0.25rem;
}
form {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
}
input,
textarea,
button {
  font: inherit;
  padding: 0.25rem 0.4rem;
}
textarea {
  flex: 1 1 auto;
  resize: vertical;
}
button {
  cursor: pointer;
}
.layout {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(14rem, 22rem) 1fr;
  gap: 1rem;
  min-height: 0;
  padding: 1rem;
}
/* Each pane is its own scroll container, so a long entity list and a long
   observation list scroll without moving each other. min-height: 0 is what
   lets a grid item shrink to the row and scroll instead of growing the page. */
nav,
main {
  min-height: 0;
  overflow: auto;
  padding: 0.75rem;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
}
ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  padding: 0.25rem 0;
  border-bottom: 1px solid #eee;
}
.muted {
  color: #6a6a6a;
  font-size: 0.9em;
}
.error {
  color: #b00020;
}
.notice {
  color: #0a7d32;
}
.badge {
  padding: 0 0.4rem;
  border: 1px solid #bbb;
  border-radius: 999px;
  color: #555;
  font-size: 0.75em;
  font-weight: normal;
}
.danger {
  color: #b00020;
}
.inline {
  display: inline-flex;
  gap: 0.4rem;
}
/* The textbox is the observation, so its form is the flexible item and the
   save/delete buttons sit at the top of the box rather than centred against it. */
.observation {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
}
.observation > form:first-of-type {
  flex: 1 1 auto;
  align-items: flex-start;
}
`;

// Rendered when the shell is built without initial node content, so GET / shows
// the same starting state as the `<main id="node">` in the contract.
const EMPTY_NODE = `<p class="muted">Select an entity or search to begin.</p>`;

// `body` is the initial inner HTML of <main id="node">. hx-target/hx-swap on
// <body> are inherited by descendant forms; the search form and the <nav>
// override them explicitly. `load` fills the index on first paint and
// `graph-changed` (an HX-Trigger sent after each successful mutation) refreshes
// it afterwards.
export function page(body: string): string {
  const node = body.trim() === "" ? EMPTY_NODE : body;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>memory kg</title>
    <style>${STYLE}</style>
    <script src="/static/htmx.min.js"></script>
  </head>
  <body hx-target="#node" hx-swap="innerHTML">
    <header>
      <h1>memory kg</h1>
      <form hx-get="/search" hx-target="#index" hx-swap="innerHTML" hx-trigger="submit, keyup changed delay:300ms">
        <input type="search" name="q" placeholder="search" autocomplete="off" />
      </form>
      <form hx-post="/entities">
        <input name="name" placeholder="name" autocomplete="off" />
        <input name="entityType" placeholder="entity type" autocomplete="off" />
        <button type="submit">create</button>
      </form>
    </header>
    <div class="layout">
      <nav id="index" hx-get="/entities" hx-trigger="load, graph-changed from:body" hx-target="this" hx-swap="innerHTML"></nav>
      <main id="node" hx-on::after-swap="this.scrollTop = 0">${node}</main>
    </div>
  </body>
</html>
`;
}
