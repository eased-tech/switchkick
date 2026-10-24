import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { generate } from "./scripts/generate.mjs";

// GitHub Pages serves the project site under /switchkick/, which is also where the config
// schema's `$id` points: https://eased-tech.github.io/switchkick/schema/v1.json.
export default defineConfig({
  site: "https://eased-tech.github.io",
  base: "/switchkick",
  integrations: [
    {
      name: "switchkick:generate",
      hooks: { "astro:config:setup": () => generate() },
    },
    starlight({
      title: "switchkick",
      description:
        "A local proxy that routes OpenAI and Anthropic API traffic through OpenRouter, using Jev to pick the model for each turn.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/eased-tech/switchkick" },
      ],
      editLink: { baseUrl: "https://github.com/eased-tech/switchkick/edit/main/docs/site/" },
      sidebar: [
        { label: "Start here", items: ["getting-started", "install", "clients"] },
        { label: "Routing", items: ["routing/static", "routing/hosted", "routing/local"] },
        { label: "Guides", items: ["guides/tuning"] },
        {
          label: "Reference",
          items: ["reference/configuration", "reference/commands", "reference/logging"],
        },
      ],
    }),
  ],
});
