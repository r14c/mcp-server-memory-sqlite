import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { KnowledgeGraphManager, startWebServer } from "../index.js";

// Integration tests for the web UI. Every assertion goes through a real HTTP
// request against a live server on an ephemeral port, so the shell, the
// fragment routes and the manager state behind them are exercised together.
// Route paths, form field names and fragment ids come from the lane contract;
// where the exact markup is an implementation detail the assertion falls back
// to manager.readGraph() rather than parsing HTML.
describe("web app", () => {
  let manager: KnowledgeGraphManager;
  let server: Server;
  let url: string;
  let testFilePath: string;

  beforeEach(async () => {
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-web-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    manager = await KnowledgeGraphManager.open(testFilePath);
    ({ server, url } = await startWebServer(manager, { port: 0 }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    try {
      manager.close();
    } catch {
      // The manager may not have been created if open() threw.
    }
    // The WAL sidecars only exist while the database is open.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await fs.unlink(`${testFilePath}${suffix}`);
      } catch {
        // ENOENT is expected for sidecars that were never created.
      }
    }
  });

  async function get(pathname: string): Promise<Response> {
    return fetch(`${url}${pathname}`);
  }

  async function postForm(
    pathname: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${url}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });
  }

  it("serves the page shell with the index, the node target and the htmx asset", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("/static/htmx.min.js");
    expect(html).toContain("/static/style.css");
    expect(html).toContain('id="index"');
    expect(html).toContain('id="node"');
    // Forms inherit the target from <body>; the index nav overrides it.
    expect(html).toContain('hx-target="#node"');
    // Selecting an entity replaces #node's content; the pane then starts at the
    // top instead of keeping the previous entity's scroll offset.
    expect(html).toContain('hx-on::after-swap="this.scrollTop = 0"');
  });

  it("lists entities on the index and shows a newly created entity", async () => {
    const empty = await (await get("/entities")).text();
    expect(empty).toContain("0 entities");
    expect(empty).toContain("No entities yet.");

    await manager.createEntities([{ name: "Alice", entityType: "person", observations: [] }]);
    const listed = await (await get("/entities")).text();
    expect(listed).toContain("1 entities");
    expect(listed).toContain("Alice");
    expect(listed).toContain("person");

    const created = await postForm("/entities", { name: "Bob", entityType: "person" });
    expect(created.status).toBe(200);
    // A successful mutation refreshes the index via the htmx trigger header.
    expect(created.headers.get("hx-trigger")).toBe("graph-changed");
    expect(await created.text()).toContain("Bob");

    const after = await (await get("/entities")).text();
    expect(after).toContain("2 entities");
    expect(after).toContain("Alice");
    expect(after).toContain("Bob");
  });

  it("searches names, entity types and observations, and tolerates short or empty queries", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      { name: "Bob", entityType: "company", observations: ["builds widgets"] },
    ]);

    const byName = await (await get("/search?q=Alice")).text();
    expect(byName).toContain("Alice");
    expect(byName).not.toContain("Bob");

    const byType = await (await get("/search?q=person")).text();
    expect(byType).toContain("Alice");
    expect(byType).not.toContain("Bob");

    const byObservation = await (await get("/search?q=Acme")).text();
    expect(byObservation).toContain("Alice");
    expect(byObservation).not.toContain("Bob");

    // Below the trigram minimum the manager falls back to a LIKE scan; the
    // route must still render a result panel instead of erroring.
    const shortResponse = await get("/search?q=ab");
    expect(shortResponse.status).toBe(200);
    const short = await shortResponse.text();
    expect(short).toMatch(/matches/);
    expect(short).not.toMatch(/class="[^"]*error[^"]*"/);

    // An empty or whitespace-only query falls back to the index panel.
    const empty = await (await get("/search?q=")).text();
    expect(empty).toContain("2 entities");
    expect(empty).toContain("Alice");
    expect(empty).toContain("Bob");

    const whitespace = await (await get("/search?q=%20")).text();
    expect(whitespace).toContain("2 entities");
  });

  it("renders an entity with its observations and its incoming and outgoing relations", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["works at Acme"] },
      { name: "Team", entityType: "group", observations: [] },
    ]);
    await manager.createRelations([{ from: "Alice", to: "Team", relationType: "part_of" }]);

    const response = await get(`/entity?name=${encodeURIComponent("Alice")}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("works at Acme");
    // Outgoing: Alice -part_of-> Team. Incoming: the materialized inverse
    // Team -contains-> Alice. Both rows touch Alice.
    expect(html).toContain("part_of");
    expect(html).toContain("contains");
    expect(html).toContain("Team");

    const team = await (await get(`/entity?name=${encodeURIComponent("Team")}`)).text();
    expect(team).toContain("part_of");
    expect(team).toContain("contains");
    expect(team).toContain("Alice");
  });

  it("resolves a case-variant name to the stored entity instead of the not-found view", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["works at Acme"] },
    ]);

    const html = await (await get(`/entity?name=${encodeURIComponent("alice")}`)).text();
    // Entity identity is NOCASE, so a case-variant request must render the
    // canonical entity: the not-found view would offer to create "alice", which
    // the manager rejects as a case-variant duplicate of "Alice".
    expect(html).toContain("works at Acme");
    expect(html).not.toContain("No entity named");
  });

  it("renders a create form for an unknown entity instead of failing", async () => {
    const response = await get(`/entity?name=${encodeURIComponent("Nobody")}`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("No entity named");
    expect(html).toContain('hx-post="/entities"');
    expect(html).toContain("Nobody");
  });

  it("creates an entity from newline-separated observations and deletes it again", async () => {
    const created = await postForm("/entities", {
      name: "Carol",
      entityType: "person",
      observations: "likes tea\n\n  plays chess  \n",
    });
    expect(created.status).toBe(200);
    expect(await created.text()).toContain("Carol");

    // Blank lines are dropped and each remaining line is trimmed.
    expect((await manager.readGraph()).entities).toEqual([
      { name: "Carol", entityType: "person", observations: ["likes tea", "plays chess"] },
    ]);

    const deleted = await postForm("/entities/delete", { entityName: "Carol" });
    expect(deleted.status).toBe(200);
    const noticeHtml = await deleted.text();
    expect(noticeHtml).toContain("Deleted");
    expect(noticeHtml).toContain("Carol");

    expect((await manager.readGraph()).entities).toEqual([]);
    expect(await (await get("/entities")).text()).not.toContain("Carol");
  });

  it("renders every observation as an editable textbox holding its text", async () => {
    await manager.createEntities([
      {
        name: "Alice",
        entityType: "person",
        observations: ["works at <Acme>", "second fact"],
      },
    ]);

    const html = await (await get(`/entity?name=Alice`)).text();
    // The textarea carries the class hook; what matters is that it holds the
    // observation text rather than rendering a separate static copy.
    expect(html).toMatch(/<textarea[^>]*name="replacement"[^>]*>works at &lt;Acme&gt;<\/textarea>/);
    expect(html).toMatch(/<textarea[^>]*name="replacement"[^>]*>second fact<\/textarea>/);
    // The text is the box, not a static copy next to it.
    expect(html).not.toContain("<span>works at");
  });

  it("stores a textarea edit with LF line breaks rather than the CRLF a browser submits", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["line one"] },
    ]);

    const response = await postForm("/observations/update", {
      entityName: "Alice",
      match: "line one",
      replacement: "line one\r\nline two",
    });
    expect(response.status).toBe(200);

    expect((await manager.readGraph()).entities[0].observations).toEqual(["line one\nline two"]);
  });

  it("adds, updates and deletes observations through the fragment routes", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["original"] },
    ]);

    const added = await postForm("/observations", { entityName: "Alice", content: "added" });
    expect(added.status).toBe(200);
    expect(await added.text()).toContain("added");
    expect((await manager.readGraph()).entities[0].observations).toContain("added");

    const updated = await postForm("/observations/update", {
      entityName: "Alice",
      match: "original",
      replacement: "edited",
    });
    expect(updated.status).toBe(200);
    expect(await updated.text()).toContain("edited");
    const afterUpdate = (await manager.readGraph()).entities[0].observations;
    expect(afterUpdate).toContain("edited");
    expect(afterUpdate).not.toContain("original");

    const removed = await postForm("/observations/delete", {
      entityName: "Alice",
      content: "added",
    });
    expect(removed.status).toBe(200);
    expect((await manager.readGraph()).entities[0].observations).toEqual(["edited"]);
  });

  it("shows the manager's message when an observation update matches nothing", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["keep me"] },
    ]);

    const response = await postForm("/observations/update", {
      entityName: "Alice",
      match: "no such observation",
      replacement: "replacement",
    });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toMatch(/class="[^"]*error[^"]*"/);
    expect(html).toContain("Observation not found on Alice: no such observation");
    // The entity is re-rendered from its unchanged state.
    expect(html).toContain("keep me");
    expect((await manager.readGraph()).entities[0].observations).toEqual(["keep me"]);
  });

  it("creates a relation with its materialized inverse and deletes both directions", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: [] },
      { name: "Team", entityType: "group", observations: [] },
    ]);

    const created = await postForm("/relations", {
      from: "Alice",
      to: "Team",
      relationType: "part_of",
    });
    expect(created.status).toBe(200);
    const html = await created.text();
    expect(html).toContain("part_of");
    expect(html).toContain("contains");

    const graph = await manager.readGraph();
    expect(graph.relations).toContainEqual({ from: "Alice", to: "Team", relationType: "part_of" });
    expect(graph.relations).toContainEqual({ from: "Team", to: "Alice", relationType: "contains" });

    const deleted = await postForm("/relations/delete", {
      from: "Alice",
      to: "Team",
      relationType: "part_of",
    });
    expect(deleted.status).toBe(200);
    // Deleting one side takes the materialized inverse with it.
    expect((await manager.readGraph()).relations).toEqual([]);
  });

  it("keeps the viewed panel when the deleted row is the materialized inverse", async () => {
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: [] },
      { name: "Team", entityType: "group", observations: [] },
    ]);
    await manager.createRelations([{ from: "Alice", to: "Team", relationType: "part_of" }]);

    // Team's panel lists `Team -contains-> Alice`; deleting that row must leave
    // the user on Team rather than following the edge back to Alice.
    const deleted = await postForm("/relations/delete", {
      from: "Team",
      to: "Alice",
      relationType: "contains",
      view: "Team",
    });
    expect(deleted.status).toBe(200);

    const html = await deleted.text();
    expect(html).toContain('<h2 class="entity__title">Team');
    expect(html).not.toContain('<h2 class="entity__title">Alice');
    expect((await manager.readGraph()).relations).toEqual([]);
  });

  it("rejects a relation whose endpoint does not exist", async () => {
    await manager.createEntities([{ name: "Alice", entityType: "person", observations: [] }]);

    const response = await postForm("/relations", {
      from: "Alice",
      to: "Ghost",
      relationType: "part_of",
    });
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toMatch(/class="[^"]*error[^"]*"/);
    expect(html).toContain("Entity with name Ghost not found");
    expect((await manager.readGraph()).relations).toEqual([]);
  });

  it("rejects a cross-origin POST and leaves the graph unchanged", async () => {
    await manager.createEntities([{ name: "Alice", entityType: "person", observations: [] }]);

    const response = await postForm(
      "/entities",
      { name: "Intruder", entityType: "person" },
      { origin: "http://evil.example" },
    );
    expect(response.status).toBe(403);

    const graph = await manager.readGraph();
    expect(graph.entities.map((entity) => entity.name)).toEqual(["Alice"]);
  });

  // A rebound page is same-origin with the name it used — it sends that name in
  // both Origin and Host — so the same-origin check alone lets it through. The
  // Host allowlist is what stops it, and it covers reads too. Node's fetch
  // ignores a caller-set Host header, so this goes through node:http.
  it("rejects a DNS-rebinding Host header on reads as well as writes", async () => {
    await manager.createEntities([{ name: "Alice", entityType: "person", observations: [] }]);
    const { port } = server.address() as { port: number };

    const raw = (pathname: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        request.on("error", reject);
        request.end();
      });

    const reboundHost = "evil.example";
    expect((await raw("/entities", { Host: reboundHost })).status).toBe(403);
    expect(
      (
        await raw("/entity?name=Alice", {
          Host: reboundHost,
          Origin: `http://${reboundHost}`,
        })
      ).status,
    ).toBe(403);

    // The canonical 127.0.0.1 Host still works.
    const ok = await raw("/entities", { Host: "127.0.0.1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("Alice");
  });

  it("escapes entity names, types, observations and queries in every fragment", async () => {
    const name = "<script>alert(1)</script>";
    const observation = `" onload="x`;
    await manager.createEntities([
      { name, entityType: "type<script>", observations: [observation] },
    ]);

    const index = await (await get("/entities")).text();
    expect(index).not.toContain("<script>alert");
    expect(index).not.toContain("type<script>");
    expect(index).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    const detail = await (await get(`/entity?name=${encodeURIComponent(name)}`)).text();
    expect(detail).not.toContain("<script>alert");
    expect(detail).not.toContain("type<script>");
    expect(detail).not.toContain(observation);
    expect(detail).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    const search = await (await get(`/search?q=${encodeURIComponent("<script")}`)).text();
    expect(search).not.toContain("<script");
  });

  it("serves the htmx asset with a javascript content type", async () => {
    const response = await get("/static/htmx.min.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("javascript");
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  it("serves the stylesheet with a css content type", async () => {
    const response = await get("/static/style.css");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("css");
    expect(await response.text()).toContain("--background");
  });
});
