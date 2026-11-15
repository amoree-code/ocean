# personal/templates/

Reusable document templates. **Never publishable** (templates themselves are generic, but the directory is private workspace).

Standardized templates for common document types used across Ocean workflows.

## Available templates

| Template | Purpose |
|---|---|
| **decision.md** | Structured decision record — context, options, chosen, reason, consequences |
| **intelligence.md** | Intelligence gathering template — source, findings, assessment, open questions |
| **project-claude.md** | Claude-specific project template — for project context and instructions |
| **session.md** | Session record template — what happened, what was decided, what's next |
| **task.md** | Task record template — scope, goal, constraints, artifacts, verification |
| **capture.md** | Quick capture into `00-inbox/captures/` |
| **daily.md** | Daily note in `01-daily/` |
| **note.md** | Your own note in `07-notes/` (agents never write there) |
| **lesson.md** · **solution.md** · **failure.md** | Knowledge records in `05-knowledge/` |
| **person.md** | One person in `02-personal/people/` (aliases in English and Arabic) |
| **interest.md** | One interest in `02-personal/interests/` (priority, keywords, sources) |
| **milestone.md** · **study.md** | Your journey: milestones and study plans |

Each record template starts with frontmatter whose `type:` decides its folder
(`kernel/packages/brain/src/memory/routing.json`); `ocean doctor` reports `TYPE_LOCATION`
when a record sits elsewhere and `FRONTMATTER_MISSING` when it has none. `{{date}}` and
`{{title}}` are filled by Obsidian's Templates plugin.

## Usage

Copy the template to the target location and fill in the frontmatter and content. Templates are starting points, not rigid forms — adapt them to the specific context.

## Privacy

The templates themselves are generic and could be published, but this directory is private workspace state. The templates may reference workspace-specific conventions. Keep them private.

See: `personal/README.md`
