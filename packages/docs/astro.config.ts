import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

const site = process.env.DOCS_SITE ?? "https://sphericalkat.github.io";
const base = process.env.DOCS_BASE ?? "/wheatley";

export default defineConfig({
  base,
  integrations: [
    starlight({
      customCss: ["./src/styles/custom.css"],
      description:
        "Self-hosted, always-on personal AI assistant written in TypeScript.",
      editLink: {
        baseUrl:
          "https://github.com/SphericalKat/wheatley/edit/main/packages/docs/",
      },
      favicon: "/favicon.svg",
      logo: {
        alt: "Wheatley",
        src: "./src/assets/wheatley-mark.svg",
      },
      plugins: [starlightLlmsTxt()],
      sidebar: [
        {
          items: [
            { label: "Install", slug: "getting-started/install" },
            { label: "Quick start", slug: "getting-started/quick-start" },
          ],
          label: "Getting started",
        },
        {
          items: [
            { label: "Models and agents", slug: "guides/models-and-agents" },
            { label: "Chat frontends", slug: "guides/frontends" },
            {
              label: "MCP servers, skills, and plugins",
              slug: "guides/extensions",
            },
            { label: "Triggers and webhooks", slug: "guides/triggers" },
            { label: "Memory", slug: "guides/memory" },
          ],
          label: "Guides",
        },
        {
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            {
              label: "Chat, approvals, and dashboard",
              slug: "reference/chat-and-dashboard",
            },
            { label: "Operations", slug: "reference/operations" },
          ],
          label: "Reference",
        },
      ],
      social: [
        {
          href: "https://github.com/SphericalKat/wheatley",
          icon: "github",
          label: "GitHub",
        },
      ],
      title: "Wheatley",
    }),
  ],
  site,
});
