# Policy — technical defaults

Load when choosing libraries or scaffolding a project.

Record the owner's defaults here once they are known, one line per need, so every session
scaffolds the same way:

| Need | Use |
|---|---|
| Package manager · runtime · language mode | <package manager> · <runtime and version> · <language settings> |
| Public site (SSR / SEO) | <framework> |
| Authenticated app or dashboard | <framework> |
| Styling / components | <styling and component library> |
| Back-end | <framework and protocol> |
| Data | <ORM and database> |
| Validation | <validation library, at every boundary> |

Until then:

- One formatter only. Never two competing ones.
- Environment variables: typed and validated at startup, fail fast on a missing one.
- Large tables: server-side pagination and sorting; virtualize before optimizing.
- Legacy repositories keep their own conventions — do not migrate unasked.
