---
title: "Leaving Gatsby Behind"
description: "Why we moved from a React SSG to Astro's zero-JS default."
date: 2024-09-12
updated: 2025-03-01
featuredImage: ../../src/images/leaving-gatsby.jpg
imageAlt: "A ship leaving a sheltered harbor"
tags: ["migration", "astro", "performance"]
author: "Dana Reyes"
canonical_url: "https://blog.example.com/leaving-gatsby/"
draft: false
---

The build times were the first signal. Then the plugin deprecation notices started stacking up in the terminal. We had 47 plugins, and half of them hadn't been updated in over a year.

## The breaking point

It wasn't any single failure. It was the compound effect of:

- Build times that grew from 30 seconds to 12 minutes
- Plugin conflicts that required careful ordering
- GraphQL queries that needed N+1 workarounds
- Image processing that consumed 4GB of RAM

## Why Astro

Astro's zero-JS default was the first attraction. But the real win was content collections. Instead of GraphQL queries scattered across templates, we have a typed schema at the project root.

```javascript
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
  }),
});
```

The migration took a weekend. The build went from 12 minutes to 8 seconds.
