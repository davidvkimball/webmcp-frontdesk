/**
 * resolveImage: bridge between CMS-stored string paths and Astro's
 * `<Image>` component, which only accepts ImageMetadata.
 *
 * When to use:
 *   - Image fields declared with `image()` in `content.config.ts` already
 *     return ImageMetadata, so use them directly with `<Image>`. You do NOT
 *     need this helper for those.
 *   - Image fields buried in passthrough JSON shapes (e.g., nested
 *     `page.section.image` in a `.passthrough()` schema) come through as
 *     plain strings. Use this helper to look them up at build time.
 *
 * Path convention: paths stored in JSON should be absolute from project
 * root, e.g., `/src/assets/images/foo.jpg`. This matches the Sveltia
 * `public_folder` setting.
 *
 * Reference: lilagents-web-pipeline §8.2.
 */
import type { ImageMetadata } from 'astro';

const imports = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/images/**/*.{jpg,jpeg,png,gif,webp,avif}',
  { eager: true },
);

export function resolveImage(
  path: string | ImageMetadata | undefined | null,
): ImageMetadata | undefined {
  if (!path) return undefined;
  // Already an ImageMetadata (i.e. field was schema-validated via image()), so pass through.
  if (typeof path !== 'string') return path;
  const normalized = path.startsWith('/') ? path : '/' + path;
  return imports[normalized]?.default;
}
