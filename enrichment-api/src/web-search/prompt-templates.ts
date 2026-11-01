import Handlebars from 'handlebars';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

/** Resolves to <repo>/prompts/web-search from both src/ (tests) and dist/ (build). */
export const WEB_SEARCH_PROMPTS_DIR = new URL('../../prompts/web-search/', import.meta.url);

/**
 * Prompt templates loaded once at startup from .hbs files, so prompts can be edited without touching code.
 * Files starting with "_" are partials, usable as {{> name}} in the other templates.
 */
export class PromptTemplates {
  private constructor(
    private readonly templates: Map<string, Handlebars.TemplateDelegate>,
    /** Changes with any edit to the templates, so cached model answers of older prompts are not reused. */
    readonly version: string,
  ) {}

  static load(directory: URL): PromptTemplates {
    // An isolated instance, so partials and helpers never leak between template sets.
    const handlebars = Handlebars.create();
    const templates = new Map<string, Handlebars.TemplateDelegate>();
    const hash = createHash('sha256');
    for (const file of readdirSync(directory).sort()) {
      if (!file.endsWith('.hbs')) continue;
      const name = file.slice(0, -'.hbs'.length);
      const source = readFileSync(new URL(file, directory), 'utf8').replace(/\r\n/g, '\n');
      hash.update(`${file}\n${source}\n`);
      if (name.startsWith('_')) handlebars.registerPartial(name.slice(1), source);
      // Prompts are plain text: HTML escaping would garble values such as "AT&T".
      else templates.set(name, handlebars.compile(source, { noEscape: true }));
    }
    return new PromptTemplates(templates, hash.digest('hex').slice(0, 16));
  }

  has(name: string): boolean {
    return this.templates.has(name);
  }

  render(name: string, context: object): string {
    const template = this.templates.get(name);
    if (!template) throw new Error(`Prompt template "${name}" does not exist`);
    return template(context).trim();
  }
}
