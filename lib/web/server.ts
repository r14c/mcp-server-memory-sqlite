import Koa from "koa";
import bodyParser from "@koa/bodyparser";
import { send } from "@koa/send";
import path from "node:path";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import type { KnowledgeGraphManager } from "../manager.js";
import { createRouter } from "./routes.js";
import { webDir } from "./templates.js";

// Resolve the htmx bundle once, at startup: a missing dependency is a packaging
// error, and failing loudly here beats serving a 404 for the one asset the app
// cannot work without. The file lives outside the project (node_modules), so
// @koa/send is rooted at its directory instead of the project root.
const require = createRequire(import.meta.url);
const htmxPath = require.resolve("htmx.org/dist/htmx.min.js");
const htmxRoot = path.dirname(htmxPath);

// Loopback names, used when no explicit allowlist is given. A browser sets Host
// from the URL it visited, so a page on a domain that rebinds DNS to 127.0.0.1
// arrives with Host: that-domain — and its Origin matches that same domain, so
// a same-origin Origin check cannot see it. The Host check is what closes that.
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];

// Koa's hostname keeps the brackets of an IPv6 literal ("[::1]"), and hostnames
// are case-insensitive.
function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

// The effective allowlist: the explicit one, plus the address the server was
// told to bind, so binding a specific interface keeps working when visited by
// that address. A wildcard bind has no name of its own, so there the explicit
// list (loopback by default) is all that is answered.
function allowedHostsFor(options: WebServerOptions): Set<string> {
  const allowed = new Set((options.allowedHosts ?? LOOPBACK_HOSTS).map(normalizeHost));
  const { host } = options;
  if (host !== undefined && host !== "0.0.0.0" && host !== "::") {
    allowed.add(normalizeHost(host));
  }
  return allowed;
}

export interface WebServerOptions {
  port?: number;
  host?: string;
  // Hostnames the app answers to. Defaults to loopback; widen it only when the
  // server is deliberately reachable under another name.
  allowedHosts?: string[];
}

export interface RunningWebServer {
  server: Server;
  url: string;
}

export function createApp(manager: KnowledgeGraphManager, options: WebServerOptions = {}): Koa {
  const app = new Koa();
  const allowedHosts = allowedHostsFor(options);

  app.on("error", (error) => {
    console.error("Web server error:", error);
  });

  // Host is checked first, and for every method: the graph is as sensitive to
  // reads as to writes, and DNS rebinding defeats an Origin-only check (the
  // rebound page is same-origin with the name it used, and that name is what
  // Host carries). Then, because a server on localhost is reachable by any page
  // the browser loads and a form POST is a "simple request" that no preflight
  // protects, state changes additionally require a same-origin Origin header. A
  // request with no Origin at all (curl, the test client) is allowed through.
  app.use(async (ctx, next) => {
    if (!allowedHosts.has(normalizeHost(ctx.hostname))) {
      ctx.status = 403;
      ctx.body = "Forbidden: unexpected Host header";
      return;
    }
    if (ctx.method !== "GET" && ctx.method !== "HEAD") {
      const origin = ctx.get("Origin");
      if (origin !== "" && origin !== `${ctx.protocol}://${ctx.host}`) {
        ctx.status = 403;
        ctx.body = "Forbidden: cross-origin request";
        return;
      }
    }
    await next();
  });

  app.use(bodyParser());

  app.use(async (ctx, next) => {
    if (ctx.path === "/static/htmx.min.js") {
      await send(ctx, "htmx.min.js", { root: htmxRoot, index: false });
      return;
    }
    if (ctx.path === "/static/style.css") {
      await send(ctx, "style.css", { root: webDir, index: false });
      return;
    }
    await next();
  });

  const router = createRouter(manager);
  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
}

export async function startWebServer(
  manager: KnowledgeGraphManager,
  options: WebServerOptions = {},
): Promise<RunningWebServer> {
  const { port = 3939, host = "127.0.0.1" } = options;
  const server = createApp(manager, options).listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  // A wildcard bind is the one case the allowlist cannot extend itself to, so
  // say so rather than leaving a server that 403s every non-loopback request
  // without explanation.
  if (host === "0.0.0.0" || host === "::") {
    console.warn(
      `Web UI bound to ${host} but answering only ${[...allowedHostsFor(options)].join(", ")}; requests carrying any other Host are rejected with 403 (pass allowedHosts to widen)`,
    );
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Web server did not bind to a TCP address: ${String(address)}`);
  }
  // Read the port back off the socket: a caller passing port 0 gets an
  // OS-assigned port that the pre-bind options cannot know. IPv6 literals need
  // brackets in a URL authority.
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  return { server, url: `http://${hostForUrl}:${address.port}` };
}
