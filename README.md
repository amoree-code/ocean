# Ocean

One repository for the whole Ocean workspace. The root mirrors `~/ocean/`: the engine in
[`kernel/`](kernel/) is public and complete, and every workspace directory is shown as an
empty folder (`.gitkeep`) — its files hold private data and never leave the machine.

The root `.gitignore` is a whitelist: anything not listed there is ignored, so a private file
cannot be committed by accident.

```
~/ocean/
├── README.md                  # this map and the privacy boundary
├── 00-inbox/                  # temporary intake awaiting triage
│   ├── INBOX.md
│   ├── captures/
│   └── archive/
├── 01-daily/                  # daily summaries
├── 02-personal/               # durable personal facts
│   ├── MEMORY.md              # memory index
│   ├── identity/
│   ├── education/
│   ├── career/
│   ├── goals/
│   └── preferences/
├── 03-professional/           # work documents and applications
│   ├── PROFESSIONAL.md
│   ├── applications/
│   ├── contracts/
│   └── interviews/
├── 04-projects/               # project registry and tasks
│   ├── PROJECTS.md
│   ├── registry.md
│   ├── backlog.md
│   └── <category>/<project>/  # company, personal, freelance, former-company, vendor,
│       │                      # uncategorized; shown here as _project/
│       ├── project.json       # id, paths, tags (the folder is the category)
│       ├── README.md
│       ├── memory/
│       ├── docs/
│       └── tasks/
├── 05-knowledge/              # reusable lessons and decisions
│   ├── KNOWLEDGE.md
│   ├── architecture/
│   ├── decisions/
│   ├── discoveries/
│   ├── failures/
│   ├── lessons/
│   ├── references/
│   ├── research/
│   ├── results/
│   └── solutions/
├── 06-templates/              # reusable templates
├── charter/                   # rules and policies
├── bridge/                    # local runtime data
│   ├── config/
│   ├── profiles/
│   ├── registry/
│   ├── integrations/
│   ├── browser/
│   ├── runtime/
│   ├── state/
│   ├── sessions/
│   ├── observations/
│   ├── installed/
│   ├── market/
│   ├── archive/
│   └── skills/                # installed or local copies
├── .index/                    # generated index, rebuildable
└── kernel/                    # the public engine
    ├── packages/
    ├── docs/
    └── scripts/
```

Files listed inside workspace directories above exist only on the owner's machine. To work on
the engine, see [`kernel/README.md`](kernel/README.md).
