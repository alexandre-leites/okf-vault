import { BundleRepository } from "../repository/bundle-repository.js";
import { ConceptRepository } from "../repository/concept-repository.js";
import { BundleService } from "./bundle-service.js";
import type { BundleRow, ConceptRow } from "../db/schema.js";

/** A node in the recursive directory tree: a concept (leaf) or a sub-bundle. */
export interface TreeNode {
  readonly name: string;
  readonly title: string;
  readonly url: string;
  readonly isDirectory: boolean;
  readonly description?: string;
  readonly children: TreeNode[];
}

export interface BundleIndex {
  readonly bundle: string;
  readonly path: string;
  readonly title?: string;
  readonly description?: string;
  readonly okfVersion?: string;
  readonly tree: TreeNode[];
}

/**
 * Synthesizes `index.md` and `log.md` for progressive disclosure
 * (OKF-FORMAT-SPEC §6/§7). These files are never stored — they are derived
 * live from the bundle tree + concepts, so they cannot drift.
 */
export class IndexService {
  constructor(
    private readonly bundles: BundleRepository,
    private readonly concepts: ConceptRepository,
    private readonly bundleService: BundleService,
  ) {}

  /**
   * Builds the recursive tree rooted at the bundle addressed by `segments`
   * (e.g. ["okf-vault"] or ["okf-vault", "api"]). Loads the whole subtree of
   * bundles and their concepts in two queries, then assembles in memory.
   */
  async index(segments: readonly string[]): Promise<BundleIndex> {
    const { bundle } = await this.bundleService.resolve(segments);
    const subtree = await this.bundles.listSubtree(bundle.id);
    const concepts = await this.concepts.listByBundles(subtree.map((b) => b.id));

    const basePath = segments.join("/");
    const tree = this.buildTree(bundle, subtree, concepts, basePath);

    return {
      bundle: segments[0]!,
      path: basePath,
      ...(bundle.title !== null ? { title: bundle.title } : {}),
      ...(bundle.description !== null ? { description: bundle.description } : {}),
      ...(bundle.okfVersion !== null ? { okfVersion: bundle.okfVersion } : {}),
      tree,
    };
  }

  private buildTree(
    parent: BundleRow,
    allBundles: BundleRow[],
    allConcepts: ConceptRow[],
    parentPath: string,
  ): TreeNode[] {
    const conceptNodes: TreeNode[] = allConcepts
      .filter((c) => c.bundleId === parent.id)
      .map((c) => ({
        name: c.slug,
        title: c.title ?? c.slug,
        url: `/${parentPath}/${c.slug}.md`,
        isDirectory: false,
        children: [],
        ...(c.description !== null ? { description: c.description } : {}),
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    const dirNodes: TreeNode[] = allBundles
      .filter((b) => b.parentId === parent.id)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((child) => {
        const childPath = `${parentPath}/${child.slug}`;
        return {
          name: child.slug,
          title: child.title ?? child.slug,
          url: `/${childPath}/`,
          isDirectory: true,
          children: this.buildTree(child, allBundles, allConcepts, childPath),
          ...(child.description !== null ? { description: child.description } : {}),
        };
      });

    return [...conceptNodes, ...dirNodes];
  }

  /**
   * Renders the synthesized OKF `index.md` (§6): the bundle title + description
   * as a header, a flat `## Concepts` list for the current level, then a
   * `## Subdirectories` section that recurses into every level with nested
   * bullet depth (`*`, `**`, `***`, …). Every concept line carries its
   * description.
   */
  async indexMarkdown(segments: readonly string[]): Promise<string> {
    const index = await this.index(segments);
    const concepts = index.tree.filter((n) => !n.isDirectory);
    const directories = index.tree.filter((n) => n.isDirectory);

    const header = index.title ?? segments[segments.length - 1]!;
    const lines: string[] = [`# ${header}`, ""];
    if (index.description) lines.push(index.description, "");

    lines.push("## Concepts", "");
    if (concepts.length === 0) lines.push("_No concepts._");
    else for (const c of concepts) lines.push(renderLeaf(c, 1));
    lines.push("");

    if (directories.length > 0) {
      lines.push("## Subdirectories", "");
      for (const d of directories) renderDir(d, 1, lines);
    }

    return `${lines.join("\n").trimEnd()}\n`;
  }

  /**
   * Synthesizes an OKF `log.md` (§7) from concept create/update timestamps
   * across the bundle subtree, grouped by ISO date, newest first.
   */
  async logMarkdown(segments: readonly string[]): Promise<string> {
    const { bundle } = await this.bundleService.resolve(segments);
    const subtree = await this.bundles.listSubtree(bundle.id);
    const pathById = this.pathsBySubtree(bundle, subtree, segments.join("/"));
    const concepts = await this.concepts.listByBundles(subtree.map((b) => b.id));

    const byDate = new Map<string, string[]>();
    const add = (at: Date, verb: string, url: string, title: string, type: string) => {
      const date = at.toISOString().slice(0, 10);
      const label =
        verb === "Creation" ? `Created \`${type}\` concept` : `Updated \`${type}\` concept`;
      const list = byDate.get(date) ?? [];
      list.push(`* **${verb}**: ${label} [${title}](${url}).`);
      byDate.set(date, list);
    };
    for (const c of concepts) {
      const url = `/${pathById.get(c.bundleId)}/${c.slug}.md`;
      const title = c.title ?? c.slug;
      add(c.createdAt, "Creation", url, title, c.type);
      if (c.updatedAt.getTime() - c.createdAt.getTime() > 1000)
        add(c.updatedAt, "Update", url, title, c.type);
    }

    const lines: string[] = [`# ${segments.join("/")} Update Log`, ""];
    const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
    if (dates.length === 0) lines.push("_No history._");
    else for (const date of dates) lines.push(`## ${date}`, ...byDate.get(date)!, "");

    return `${lines.join("\n").trimEnd()}\n`;
  }

  /** Maps every bundle id in a subtree to its absolute slug path. */
  private pathsBySubtree(
    root: BundleRow,
    subtree: BundleRow[],
    rootPath: string,
  ): Map<string, string> {
    const paths = new Map<string, string>([[root.id, rootPath]]);
    const walk = (id: string, path: string) => {
      for (const child of subtree.filter((b) => b.parentId === id)) {
        const childPath = `${path}/${child.slug}`;
        paths.set(child.id, childPath);
        walk(child.id, childPath);
      }
    };
    walk(root.id, rootPath);
    return paths;
  }
}

/** Renders a concept leaf at the given bullet depth, with its description. */
function renderLeaf(node: TreeNode, depth: number): string {
  const indent = "  ".repeat(depth - 1);
  return `${indent}* [${node.title}](${node.url})${node.description ? ` - ${node.description}` : ""}`;
}

/** Renders a directory node and recurses into its children, increasing depth. */
function renderDir(node: TreeNode, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth - 1);
  lines.push(`${indent}* [${node.name}](${node.url})`);
  for (const child of node.children) {
    if (child.isDirectory) renderDir(child, depth + 1, lines);
    else lines.push(renderLeaf(child, depth + 1));
  }
}
