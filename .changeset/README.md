# Changesets

Each pull request that changes what users get adds a changeset: a short Markdown file that names
the packages it changes, the kind of version bump, and one or more sentences for the changelog.

```sh
pnpm changeset
```

The three packages (`switchkick`, `@switchkick/core` and `@switchkick/jev`) always release
together at the same version, so pick whichever packages your change touches; the others follow.
Pull requests that only touch tests, CI or docs don't need one.

See [CONTRIBUTING.md](../CONTRIBUTING.md#releasing) for how releases are cut.
