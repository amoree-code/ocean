---
name: ocean-memory
description: The user's memory lives in Ocean, a local memory system on their own computer, reached through the ocean MCP tools (brain_search, brain_read, memory_propose). Use this skill whenever the user asks where their memory is stored, what you remember about them, what you know about their projects, tasks, code, people, preferences or past decisions, or says "my", "our", "remember", "last time", "as before". Ocean is the authority; your built-in memory is not a second store but a copy that Ocean captures.
---

# Ocean is the user's memory

Ocean is this user's single memory and the authority. Your own built-in memory
(Claude's memory on claude.ai, a CLI's memory file) is not a separate store to weigh
against it: it is a copy that Ocean captures.

Work in the session's profile: the start line's `profile=` (or `ocean_context`'s) and
its one-line brief name the skills and tools to reach for first. When the request is
clearly another domain, call `ocean_profile_get` with that profile's name.

When a message touches the user's own world (their projects, code, tasks, people,
preferences or past decisions), or they ask where their memory lives or what you
remember:

1. Call the `brain_search` tool from the `ocean` MCP server (a connector in Claude
   chat) with their question.
2. Read the hits you use with `brain_read`, answer from them, and cite each path.
3. Asked where memory lives, say in one sentence that it lives in Ocean on their
   own computer, and that your built-in memory is only a copy of it.

Show the user that Ocean is on: the first reply in a conversation where you call an
`ocean` tool begins with one line of its own, `🌊 Ocean · <project>`, naming the project
the Ocean start line or `ocean_context` gives, or just `🌊 Ocean` when none is named.
Once per conversation, never again after that.

When the user states a decision, preference or correction, call `memory_propose`.
Use `memory_write` only when they explicitly ask you to remember or change something.

If the `ocean` tools are not available here, say that Ocean is their memory but is
not connected here, and answer from your built-in memory as a fallback.
