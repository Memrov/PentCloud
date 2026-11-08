import { defineConfig } from "vite-plus";
import { verificationTasks } from "./scripts/verification-tasks";
import { workerProjects } from "./apps/control-plane/vite.workers.config";

export default defineConfig({
  test: {
    projects: [
      "apps/control-plane/vite.config.ts",
      "apps/control-plane/vite.contract.config.ts",
      ...workerProjects
    ]
  },
  run: {
    // Scripts run fresh. Only the static check task opts into caching.
    cache: { scripts: false, tasks: true },
    tasks: {
      "check:static": {
        command: ["vp fmt --check .", "vp lint --max-warnings=313"]
      },
      ...verificationTasks
    }
  },
  staged: {
    "*": "vp check --fix"
  },
  fmt: {
    printWidth: 80,
    trailingComma: "none",
    ignorePatterns: [
      "**/*.md",
      "**/*.json",
      "**/*.jsonc",
      "**/*.yml",
      "**/*.yaml",
      "**/*.html",
      "**/worker-configuration.d.ts",
      "**/dist/**",
      "**/dist-customer/**",
      ".pentcloud-tools/**",
      "apps/control-plane/test/fixtures/**",
      "contracts/**",
      "docs/**",
      "internal/**",
      "media/**",
      "templates/**",
      "upstream/**"
    ]
  },
  lint: {
    plugins: ["react", "jsx-a11y", "typescript", "vitest"],
    categories: {
      correctness: "error"
    },
    rules: {
      "no-unused-expressions": "off",
      "vitest/no-focused-tests": "error",
      "vitest/expect-expect": [
        "error",
        {
          assertFunctionNames: ["expect", "assert", "assert.*", "assertCase"]
        }
      ],
      "vitest/no-identical-title": "error",
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/require-to-throw-message": "warn",
      // Typed mock implementations infer their signatures; parameterized cases
      // intentionally branch on their explicit input matrix.
      "vitest/require-mock-type-parameters": "off",
      "vitest/no-conditional-expect": "off",
      complexity: ["warn", { max: 50 }],
      "typescript/no-deprecated": "error",
      "no-this-alias": "off",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      // Existing backlog warns until each finding is fixed or justified.
      "typescript/no-explicit-any": "warn",
      "typescript/no-base-to-string": "warn",
      "typescript/restrict-template-expressions": "warn",
      "typescript/unbound-method": "warn",
      "typescript/no-redundant-type-constituents": "warn",
      // Durable Object RPC return types can look non-thenable to the checker.
      "typescript/await-thenable": "warn",
      "react/refs": "warn",
      "react/set-state-in-effect": "warn",
      "react/purity": "warn",
      "react/immutability": "warn",
      "react/error-boundaries": "warn",
      "react/no-children-prop": "warn",
      "jsx-a11y/prefer-tag-over-role": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/control-has-associated-label": "warn",
      "no-control-regex": "warn",
      "no-useless-escape": "warn",
      "no-unsafe-finally": "warn",
      "no-unsafe-optional-chaining": "warn",
      "require-yield": "warn",
      "vite-plus/prefer-vite-plus-imports": "error"
    },
    overrides: [
      {
        // node:test registers tests with un-awaited calls.
        files: ["**/*.test.mjs", "scripts/test-*.mjs", "**/*.node.mjs"],
        rules: {
          "typescript/no-floating-promises": "off"
        }
      }
    ],
    ignorePatterns: [
      "**/worker-configuration.d.ts",
      "**/dist/**",
      "**/dist-customer/**",
      ".pentcloud-tools/**",
      "upstream/**"
    ],
    options: {
      typeAware: true,
      typeCheck: true
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin"
      }
    ]
  }
});
