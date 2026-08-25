/**
 * Content collection schemas.
 *
 * Image fields use Astro's `image()` helper (from the function-form schema)
 * so they flow through `astro:assets` at build time, so automatic WebP/AVIF,
 * responsive srcsets, lazy loading, layout-shift prevention. Sveltia uploads
 * to `src/assets/images/` (see public/admin/config.yml) so paths resolve.
 *
 * Reference: lilagents-web-pipeline §3 (schemas), §6.1 (Sveltia media),
 * §8.0 (image() helper rule), §8.1 (<Image> rendering).
 *
 * Collections shipped in the starter:
 *   blog     = Markdown posts (src/content/blog/*.md)
 *   settings = Site-wide settings JSON (src/content/settings/site.json)
 *
 * Add more collections as the site grows (pages, services, team, etc.).
 * Always use strict Zod schemas. Avoid z.any() in production.
 *
 * For passthrough fields whose images can't be schema-validated, use the
 * `resolveImage()` helper in src/lib/images.ts.
 */
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ pattern: ['*.md', '!_*.md'], base: './src/content/blog' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    description: z.string(),
    date: z.union([z.string(), z.date()]).transform((val) =>
      val instanceof Date ? val.toISOString().split('T')[0] : val
    ),
    draft: z.boolean().optional().default(false),
    image: image().optional(),
  }),
});

const settings = defineCollection({
  loader: glob({ pattern: '*.json', base: './src/content/settings' }),
  schema: ({ image }) => z.object({
    siteName: z.string(),
    siteDescription: z.string().optional(),
    ogImage: image().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    header: z.object({
      logo: image().optional(),
      siteName: z.string().optional(),
      ctaLink: z.string().optional(),
      ctaLabel: z.string().optional(),
      menu: z.array(
        z.object({
          label: z.string(),
          href: z.string(),
        })
      ),
    }),
    footer: z.object({
      copyright: z.string().optional(),
    }),
  }),
});

export const collections = { blog, settings };
