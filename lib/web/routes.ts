import Router from "@koa/router";
import type { Context } from "koa";
import type { KnowledgeGraphManager } from "../manager.js";
import { errorBanner, indexPanel, nodePanel, notice, searchResults } from "./fragments.js";
import { render } from "./templates.js";

// Body and query fields arrive as a single value, a repeated field (string[]),
// or absent. Collapse all three shapes to a string so handlers never branch on
// the parser's output.
function field(source: unknown, key: string): string {
  if (typeof source !== "object" || source === null) return "";
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A form field a mutation cannot do anything with. Reported as a banner like a
// manager error rather than thrown at the HTTP layer, so the user sees the
// message in the panel they were editing.
function requireField(value: string, message: string): void {
  if (value.trim() === "") throw new Error(message);
}

function renderHtml(ctx: Context, fragment: string): void {
  ctx.status = 200;
  ctx.type = "html";
  ctx.body = fragment;
}

// The panel for one entity, with a banner above it when the mutation that
// produced it failed. `name` is what the caller asked for, so a name the graph
// does not have renders the not-found view (create form) rather than an empty
// panel.
async function nodeFragment(
  manager: KnowledgeGraphManager,
  name: string,
  banner?: string,
): Promise<string> {
  const [graph, entities] = await Promise.all([manager.openNodes([name]), manager.listEntities()]);
  const names = entities.map((entity) => entity.name);
  // openNodes matches names case-insensitively (the graph's entity identity is
  // NOCASE), so read the canonical casing back off the result before rendering:
  // nodePanel compares names exactly, and a case-variant request would
  // otherwise show the not-found view, whose create form the manager then
  // rejects as a duplicate — leaving the caller stuck on a form that does
  // nothing.
  const canonical = graph.entities[0]?.name ?? name;
  return (banner ? errorBanner(banner) : "") + nodePanel(graph, canonical, names);
}

// Every mutation answers with a 200, even when the manager rejected the write:
// htmx only swaps 2xx responses, so a failure has to arrive as a successful
// body carrying the message plus the panel the form was rendered from. `name`
// is the entity the form was about, used to re-render that panel either way.
async function mutate(
  ctx: Context,
  manager: KnowledgeGraphManager,
  name: string,
  run: () => Promise<string>,
): Promise<void> {
  try {
    const fragment = await run();
    // The index pane renders from its own hx-trigger="graph-changed" listener.
    ctx.set("HX-Trigger", "graph-changed");
    renderHtml(ctx, fragment);
  } catch (error) {
    renderHtml(ctx, await nodeFragment(manager, name, messageOf(error)));
  }
}

export function createRouter(manager: KnowledgeGraphManager): Router {
  const router = new Router();

  router.get("/", (ctx) => {
    // No initial node content: the shell renders its own placeholder, and the
    // index pane fills itself from its hx-trigger="load" listener.
    renderHtml(ctx, render("page", { node: "" }));
  });

  router.get("/search", async (ctx) => {
    const query = field(ctx.query, "q");
    renderHtml(
      ctx,
      query.trim() === ""
        ? indexPanel(await manager.listEntities())
        : searchResults(await manager.searchNodes(query), query),
    );
  });

  router.get("/entities", async (ctx) => {
    renderHtml(ctx, indexPanel(await manager.listEntities()));
  });

  router.get("/entity", async (ctx) => {
    const name = field(ctx.query, "name");
    renderHtml(ctx, await nodeFragment(manager, name));
  });

  router.post("/entities", (ctx) => {
    const name = field(ctx.request.body, "name");
    const entityType = field(ctx.request.body, "entityType");
    // One observation per line; blank lines are paste noise, not observations.
    const observations = field(ctx.request.body, "observations")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return mutate(ctx, manager, name, async () => {
      requireField(name, "name is required");
      requireField(entityType, "entityType is required");
      await manager.createEntities([{ name, entityType, observations }], { source: "web" });
      return nodeFragment(manager, name);
    });
  });

  router.post("/entities/delete", (ctx) => {
    const entityName = field(ctx.request.body, "entityName");
    return mutate(ctx, manager, entityName, async () => {
      requireField(entityName, "entityName is required");
      await manager.deleteEntities([entityName]);
      return notice(`Deleted ${entityName}`);
    });
  });

  router.post("/observations", (ctx) => {
    const entityName = field(ctx.request.body, "entityName");
    const content = field(ctx.request.body, "content");
    return mutate(ctx, manager, entityName, async () => {
      requireField(entityName, "entityName is required");
      requireField(content, "content is required");
      await manager.addObservations([{ entityName, contents: [content] }], { source: "web" });
      return nodeFragment(manager, entityName);
    });
  });

  router.post("/observations/update", (ctx) => {
    const entityName = field(ctx.request.body, "entityName");
    const match = field(ctx.request.body, "match");
    // A textarea submits its line breaks as CRLF while the graph stores LF, so
    // normalise before storing: otherwise every save silently rewrites the line
    // endings of whatever the user edited.
    const replacement = field(ctx.request.body, "replacement").replaceAll(/\r\n?/g, "\n");
    return mutate(ctx, manager, entityName, async () => {
      requireField(entityName, "entityName is required");
      requireField(match, "match is required");
      await manager.updateObservations([{ entityName, match, replacement }]);
      return nodeFragment(manager, entityName);
    });
  });

  router.post("/observations/delete", (ctx) => {
    const entityName = field(ctx.request.body, "entityName");
    const content = field(ctx.request.body, "content");
    return mutate(ctx, manager, entityName, async () => {
      requireField(entityName, "entityName is required");
      requireField(content, "content is required");
      await manager.deleteObservations([{ entityName, observations: [content] }]);
      return nodeFragment(manager, entityName);
    });
  });

  router.post("/relations", (ctx) => {
    const from = field(ctx.request.body, "from");
    const to = field(ctx.request.body, "to");
    const relationType = field(ctx.request.body, "relationType");
    return mutate(ctx, manager, from, async () => {
      requireField(from, "from is required");
      requireField(to, "to is required");
      requireField(relationType, "relationType is required");
      await manager.createRelations([{ from, to, relationType }], { source: "web" });
      return nodeFragment(manager, from);
    });
  });

  router.post("/relations/delete", (ctx) => {
    const from = field(ctx.request.body, "from");
    const to = field(ctx.request.body, "to");
    const relationType = field(ctx.request.body, "relationType");
    // Re-render the panel the form was rendered in, not the edge's `from`: the
    // materialized inverse puts its far endpoint on screen, and following the
    // edge there would move the user off the entity they were looking at.
    const view = field(ctx.request.body, "view") || from;
    return mutate(ctx, manager, view, async () => {
      requireField(from, "from is required");
      requireField(to, "to is required");
      requireField(relationType, "relationType is required");
      await manager.deleteRelations([{ from, to, relationType }]);
      return nodeFragment(manager, view);
    });
  });

  return router;
}
