import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { DocEntry } from "./catalog.js";

type MarkdownTree = ReturnType<ReturnType<typeof unified>["parse"]>;
export interface DocHeading {
  id: string;
  title: string;
  depth: number;
}
export interface DocArticle extends DocEntry {
  markdown: string;
  headings: DocHeading[];
  sections: { id: string; title: string; text: string }[];
}
function headings(tree: MarkdownTree) {
  const slugger = new GithubSlugger();
  const result: DocHeading[] = [];
  const visit = (node: any) => {
    if (node.type === "heading") {
      const title = toString(node),
        id = slugger.slug(title);
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
      result.push({ id, title, depth: node.depth });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return result;
}
/** Same slugger for rendering and the section index, including duplicate/formatted headings. */
export function headingIds() {
  return (tree: MarkdownTree) => {
    headings(tree);
  };
}
export function createArticle(entry: DocEntry, markdown: string): DocArticle {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const index = headings(tree),
    sections = [{ id: "", title: entry.title, text: entry.description }];
  let headingIndex = 0;
  for (const node of tree.children) {
    if (node.type === "heading") {
      const heading = index[headingIndex++];
      sections.push({ id: heading.id, title: heading.title, text: heading.title });
    } else sections[sections.length - 1].text += " " + toString(node);
  }
  return {
    ...entry,
    markdown,
    headings: index.filter((h) => h.depth === 2 || h.depth === 3),
    sections,
  };
}
export function markdownLinks(markdown: string): string[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const links: string[] = [];
  const visit = (node: any) => {
    if (node.type === "link" || node.type === "definition") links.push(node.url);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return links;
}
export function searchDocs(articles: DocArticle[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length)
    return articles
      .slice(0, 8)
      .map((article) => ({ article, id: "", title: article.title, snippet: article.description }));
  return articles
    .flatMap((article) => {
      const candidates = article.sections.filter((s) =>
        terms.every((t) => (article.title + " " + s.text).toLowerCase().includes(t)),
      );
      return candidates.map((s) => {
        const text = s.text.replace(/\s+/g, " "),
          position = text.toLowerCase().indexOf(terms[0]);
        const start = Math.max(0, position - 48);
        return {
          article,
          id: s.id,
          title: s.title,
          snippet: (start ? "…" : "") + text.slice(start, start + 170),
          score: terms.filter((t) => s.title.toLowerCase().includes(t)).length,
        };
      });
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}
