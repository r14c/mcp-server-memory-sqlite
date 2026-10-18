import path from "node:path";
import { fileURLToPath } from "node:url";
import { Eta } from "eta";

// Both the TypeScript source and dist/ resolve these paths the same way, so the
// build's asset copy is the only thing standing between a checkout and a working
// package. `webDir` is also the root the stylesheet is served from.
export const webDir = fileURLToPath(new URL(".", import.meta.url));
export const templatesDir = path.join(webDir, "templates");

// `<%= %>` is escaped (the same five characters the old escapeHtml covered) and
// `<%~ %>` is raw; raw is used only for include(), i.e. to place an
// already-rendered template, never to interpolate a value.
// Templates are static, so compiled ones are cached for the process lifetime.
const eta = new Eta({ views: templatesDir, defaultExtension: ".html", cache: true });

export function render(template: string, data: object): string {
  return eta.render(template, data);
}
