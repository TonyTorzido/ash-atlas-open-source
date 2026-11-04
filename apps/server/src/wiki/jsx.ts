import type { WikiContentNode } from "@ash-atlas/shared";

/**
 * Minimal JSX runtime that builds a serializable content tree instead of React elements, so wiki
 * articles can be authored as JSX on the server and rendered by the (signed-in) client.
 * Lowercase tags are HTML; function components expand here; string-valued constants such as
 * `const WikiLink = "WikiLink"` stay as named client components.
 */
export type Child = WikiContentNode | boolean | null | undefined | readonly Child[];
type Component = (props: Record<string, unknown> & { children: Child[] }) => WikiContentNode;

function flatten(children: readonly Child[], out: WikiContentNode[] = []): WikiContentNode[] {
  for (const child of children) {
    if (Array.isArray(child)) flatten(child, out);
    else if (child !== null && child !== undefined && typeof child !== "boolean") out.push(child as WikiContentNode);
  }
  return out;
}

export function h(type: string | Component, props: Record<string, unknown> | null, ...children: Child[]): WikiContentNode {
  const content = flatten(children);
  if (typeof type === "function") return type({ ...props, children: content });
  const attributes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (name !== "key" && name !== "children" && value !== undefined) attributes[name] = value;
  }
  return {
    t: type,
    ...(Object.keys(attributes).length ? { p: attributes } : {}),
    ...(content.length ? { c: content } : {})
  };
}

/** Fragment: an element with an empty tag, rendered as a React fragment by the client. */
export function Fragment(props: { children?: Child[] }): WikiContentNode {
  return { t: "", c: flatten(props.children ?? []) };
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace h {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace JSX {
    export type Element = WikiContentNode;
    export interface ElementChildrenAttribute { children: unknown }
    export interface IntrinsicElements { [tag: string]: Record<string, unknown> }
  }
}
