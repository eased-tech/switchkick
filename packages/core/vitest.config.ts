import { defineProject } from "vitest/config";

// Resolve workspace packages to their TypeScript sources so tests never depend on a prior build.
const conditions = ["switchkick-source"];

export default defineProject({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: { include: ["test/**/*.test.ts"] },
});
