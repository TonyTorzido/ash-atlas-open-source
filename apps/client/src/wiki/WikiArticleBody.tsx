import type { WikiContentNode, WikiMatchupData, WikiRosterCreature } from "@ash-atlas/shared";
import { createElement, Fragment, type ReactNode } from "react";

import { CreatureRoster } from "./CreatureRoster.js";
import { MatchupExplorer } from "./MatchupExplorer.js";
import { WikiArt } from "./wikiArt.js";

/** Only these tags can appear in server-sent article content. */
const HTML_TAGS: ReadonlySet<string> = new Set([
  "p", "h2", "h3", "h4", "strong", "em", "small", "span", "div", "aside", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "caption"
]);

export function WikiLink({ slug, children }: { slug: string; children?: ReactNode }): ReactNode {
  return <a className="wiki-inline-link" href={`/wiki/${slug}`}>{children}</a>;
}

/** Renders a server-sent article tree; unknown tags are dropped, never executed. */
export function WikiArticleBody({ node }: { node: WikiContentNode }): ReactNode {
  return renderNode(node, "0");
}

function renderNode(node: WikiContentNode, key: string): ReactNode {
  if (typeof node === "string" || typeof node === "number") return node;
  const children = node.c?.map((child, index) => renderNode(child, `${key}.${index}`));
  const props: Record<string, unknown> = { ...node.p };
  switch (node.t) {
    case "": return <Fragment key={key}>{children}</Fragment>;
    case "WikiLink": return <WikiLink key={key} slug={String(props.slug)}>{children}</WikiLink>;
    case "WikiArt": return <WikiArt key={key} kind={props.kind === "item" ? "item" : "monster"} id={typeof props.id === "string" ? props.id : null} name={String(props.name ?? "")} />;
    case "CreatureRoster": return <CreatureRoster key={key} creatures={(props.creatures ?? []) as WikiRosterCreature[]} />;
    case "MatchupExplorer": return props.matchups ? <MatchupExplorer key={key} matchups={props.matchups as WikiMatchupData} /> : null;
    default: return HTML_TAGS.has(node.t) ? createElement(node.t, { ...props, key }, children) : null;
  }
}
