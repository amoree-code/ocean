---
name: business-logic
description: Convert a product request into explicit rules, states, permissions, exceptions, and verifiable acceptance criteria.
version: 1.0.0
category: core
---

# Business Logic

Use after the desired outcome is understood and before implementation.

Describe:

- inputs and outputs;
- entities and state transitions;
- rules and precedence when rules conflict;
- permissions and approval boundaries;
- validation and failure cases;
- idempotency and retry safety;
- acceptance criteria and verification signals.

Keep rules domain-specific and executable. Never invent missing policy, identity, money, legal, or academic data; mark it as a blocker.
