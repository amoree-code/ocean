# config/

Private application configuration. **Never publishable.**

Managed by `ocean setup` and the runtime. Contains only machine-specific startup documentation; canonical governance (charter, policies, task contract) lives under `charter/`.

## Layout

```
config/
└── startup/           startup integration documentation (OS-level launch entries live in the OS)
```

## Privacy

All files under `config/` are private workspace state. They may reference workspace-internal paths and contain behavioral configuration specific to this machine. Never commit or publish.

## Management

- Created by `ocean setup` during workspace bootstrap.
- `bridge/config/` is restricted to `0700` permissions as part of the private system tree.
