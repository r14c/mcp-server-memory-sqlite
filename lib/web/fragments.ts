import { RELATION_SEMANTICS, inverseOf } from "../ontology.js";
import type { Entity, KnowledgeGraph, Relation } from "../types.js";
import { escapeHtml } from "./html.js";

// The index list only needs identity, not observations or relations.
export interface EntityRef {
  name: string;
  entityType: string;
}

const RELATION_TYPES = Object.keys(RELATION_SEMANTICS);

// Entity references are buttons, not links: htmx loads the entity into #node
// without any client-side JS. The name travels as a query parameter, so it is
// URL-encoded there and HTML-escaped in the attribute and label.
function entityButton(name: string): string {
  return `<button hx-get="/entity?name=${encodeURIComponent(name)}" hx-target="#node" hx-swap="innerHTML">${escapeHtml(name)}</button>`;
}

function hiddenField(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function entityRows(entities: EntityRef[]): string {
  return entities
    .map(
      (entity) =>
        `<li>${entityButton(entity.name)} <span class="badge">${escapeHtml(entity.entityType)}</span></li>`,
    )
    .join("\n");
}

export function indexPanel(entities: EntityRef[]): string {
  const body =
    entities.length === 0
      ? `<p class="muted">No entities yet.</p>`
      : `<ul>\n${entityRows(entities)}\n</ul>`;
  return `<section class="panel">
<h2>${entities.length} entities</h2>
${body}
</section>`;
}

export function searchResults(graph: KnowledgeGraph, query: string): string {
  const body =
    graph.entities.length === 0
      ? `<p class="muted">No matches.</p>`
      : `<ul>\n${entityRows(graph.entities)}\n</ul>`;
  return `<section class="panel">
<h2>${graph.entities.length} matches for “${escapeHtml(query)}”</h2>
${body}
</section>`;
}

// The manager canonicalizes names before writing and matching, so an exact
// comparison is correct here; `entityNames` is the full name list used to
// populate the relation form's datalist.
export function nodePanel(graph: KnowledgeGraph, name: string, entityNames: string[]): string {
  const entity = graph.entities.find((candidate) => candidate.name === name);
  if (entity === undefined) {
    return `<section class="panel">
<p class="error">No entity named “${escapeHtml(name)}”.</p>
<form hx-post="/entities">
  <input name="name" value="${escapeHtml(name)}" placeholder="name" autocomplete="off" />
  <input name="entityType" placeholder="entity type" autocomplete="off" />
  <button type="submit">create</button>
</form>
</section>`;
  }

  return `<section class="panel">
<h2>${escapeHtml(entity.name)} <span class="badge">${escapeHtml(entity.entityType)}</span></h2>
<form class="inline" hx-post="/entities/delete" hx-confirm="Delete ${escapeHtml(entity.name)} and all its relations?">
  ${hiddenField("entityName", entity.name)}
  <button class="danger" type="submit">delete entity</button>
</form>
${observationSection(entity)}
${relationSection(entity.name, graph.relations, entityNames)}
</section>`;
}

function observationSection(entity: Entity): string {
  // The observation itself is the textbox: `match` carries the stored text so
  // the manager can find the row, and the textarea is what the user edits. It
  // used to render the text twice, once as static text and once as a one-line
  // input, which made long observations awkward to edit.
  const items = entity.observations.map(
    (observation) => `<li class="observation">
<form hx-post="/observations/update">
  ${hiddenField("entityName", entity.name)}
  ${hiddenField("match", observation)}
  <textarea name="replacement" rows="2">${escapeHtml(observation)}</textarea>
  <button type="submit">save</button>
</form>
<form hx-post="/observations/delete" hx-confirm="Delete this observation from ${escapeHtml(entity.name)}?">
  ${hiddenField("entityName", entity.name)}
  ${hiddenField("content", observation)}
  <button class="danger" type="submit">delete</button>
</form>
</li>`,
  );
  const body =
    entity.observations.length === 0
      ? `<p class="muted">No observations yet.</p>`
      : `<ul>\n${items.join("\n")}\n</ul>`;
  return `<h3>Observations (${entity.observations.length})</h3>
${body}
<form hx-post="/observations">
  ${hiddenField("entityName", entity.name)}
  <input name="content" placeholder="new observation" autocomplete="off" />
  <button type="submit">add</button>
</form>`;
}

function relationSection(entityName: string, relations: Relation[], entityNames: string[]): string {
  const touching = relations.filter(
    (relation) => relation.from === entityName || relation.to === entityName,
  );
  const items = touching.map((relation) => {
    const hidden = [
      hiddenField("from", relation.from),
      hiddenField("to", relation.to),
      hiddenField("relationType", relation.relationType),
      // The panel this row is rendered in, which is not always `from`: the
      // materialized inverse lists its far endpoint here.
      hiddenField("view", entityName),
    ].join("\n  ");
    return `<li>
${entityButton(relation.from)} → <em>${escapeHtml(relation.relationType)}</em> → ${entityButton(relation.to)}
<form class="inline" hx-post="/relations/delete" hx-confirm="Delete the relation ${escapeHtml(relation.from)} → ${escapeHtml(relation.to)}?">
  ${hidden}
  <button class="danger" type="submit">delete</button>
</form>
</li>`;
  });
  const body =
    touching.length === 0
      ? `<p class="muted">No relations yet.</p>`
      : `<ul>\n${items.join("\n")}\n</ul>`;
  return `<h3>Relations (${touching.length})</h3>
${body}
<form hx-post="/relations">
  ${hiddenField("from", entityName)}
  <input name="to" list="entity-names" placeholder="to" autocomplete="off" />
  <input name="relationType" list="relation-types" placeholder="relation type" autocomplete="off" />
  <button type="submit">add</button>
  <datalist id="entity-names">
${entityNames.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("\n")}
  </datalist>
  <datalist id="relation-types">
${RELATION_TYPES.map((type) => relationTypeOption(type)).join("\n")}
  </datalist>
</form>`;
}

// The relation type is free text, so the inverse hint travels as the option's
// label: picking `part_of` from the datalist shows that it writes `contains`.
function relationTypeOption(relationType: string): string {
  const inverse = inverseOf(relationType);
  const hint = inverse === undefined ? "" : `materializes ${escapeHtml(inverse)}`;
  return `<option value="${escapeHtml(relationType)}">${hint}</option>`;
}

export function errorBanner(message: string): string {
  return `<p class="error" role="alert">${escapeHtml(message)}</p>`;
}

export function notice(message: string): string {
  return `<p class="notice" role="status">${escapeHtml(message)}</p>`;
}
