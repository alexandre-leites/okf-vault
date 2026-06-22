export type SubtreeEntry = { id: string; slug: string; parentId: string | null };

/**
 * Builds a map from bundle ID to its full slug path from the subtree root.
 * The root is detected by finding the bundle whose `slug` matches `rootSlug`
 * and whose `parentId` does NOT appear anywhere in the subtree (i.e. it is
 * the top-most visible node). This works for both full root bundles and
 * subdirectory-only subtrees.
 */
export function pathsBySubtree(rootSlug: string, subtree: SubtreeEntry[]): Map<string, string> {
  const root = subtree.find(
    (b) => b.slug === rootSlug && !subtree.some((p) => p.id === b.parentId),
  );
  const paths = new Map<string, string>();
  if (!root) return paths;
  paths.set(root.id, rootSlug);
  const walk = (id: string, path: string) => {
    for (const child of subtree.filter((b) => b.parentId === id)) {
      const childPath = `${path}/${child.slug}`;
      paths.set(child.id, childPath);
      walk(child.id, childPath);
    }
  };
  walk(root.id, rootSlug);
  return paths;
}
