import type { WikiBuiltInContent } from "@ash-atlas/shared";

import { WIKI_ARTICLES, WIKI_CATEGORIES } from "./articles.js";

let cached: WikiBuiltInContent | null = null;

/**
 * Built-in wiki articles as serializable content trees. They live only on the server and ship
 * through the signed-in wiki API, never in the public client bundle.
 */
export function builtInWikiContent(): WikiBuiltInContent {
  cached ??= {
    categories: WIKI_CATEGORIES.map((category) => ({ ...category })),
    articles: WIKI_ARTICLES.map((article) => ({
      slug: article.slug, title: article.title, summary: article.summary, category: article.category,
      tags: [...article.tags], content: article.content()
    }))
  };
  return cached;
}
