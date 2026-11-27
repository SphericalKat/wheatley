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
        "Self-hosted, always-on personal AI assistant. Install Wheatley, connect your favorite AI model, and chat from your terminal, web dashboard, Telegram, Slack, or Discord.",
      editLink: {
        baseUrl:
          "https://github.com/SphericalKat/wheatley/edit/main/packages/docs/",
      },
      favicon: "/favicon.svg",
      head: [
        {
          attrs: {
            href: "https://fonts.googleapis.com",
            rel: "preconnect",
          },
          tag: "link",
        },
        {
          attrs: {
            crossorigin: "",
            href: "https://fonts.gstatic.com",
            rel: "preconnect",
          },
          tag: "link",
        },
        {
          attrs: {
            href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
            rel: "stylesheet",
          },
          tag: "link",
        },
      ],
      logo: {
        alt: "Wheatley",
        src: "./src/assets/wheatley-mark.svg",
      },
      plugins: [starlightLlmsTxt()],
      sidebar: [
        {
          items: [
            { label: "Install Wheatley", slug: "getting-started/install" },
            { label: "Quick start", slug: "getting-started/quick-start" },
          ],
          label: "Getting started",
        },
        {
          items: [
            {
              label: "Connect your AI model",
              slug: "guides/models-and-agents",
            },
            { label: "Connect a chat app", slug: "guides/frontends" },
            {
              label: "MCP servers, skills, and plugins",
              slug: "guides/extensions",
            },
            { label: "Schedules and webhooks", slug: "guides/triggers" },
            { label: "Memory", slug: "guides/memory" },
          ],
          label: "Guides",
        },
        {
          items: [
            { label: "Configuration", slug: "reference/configuration" },
            {
              label: "CLI chat and dashboard",
              slug: "reference/chat-and-dashboard",
            },
            { label: "Day-to-day operations", slug: "reference/operations" },
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
      tableOfContents: {
        maxHeadingLevel: 3,
        minHeadingLevel: 2,
      },
      title: "Wheatley",
    }),
  ],
  site,
});
