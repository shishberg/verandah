---
description: Write or update a specification defining precise behaviour for a feature
argument-hint: "[topic]"
allowed-tools: Read, Edit, Write, Glob, Grep, Bash, Agent
---

# Write a specification

Create or update a spec document in `docs/spec/` for the topic: `$ARGUMENTS`

A spec is derived from a design document. The design explores the problem; the spec defines the contract.

## What a spec covers

- **Conventions**: naming, paths, exit codes, common patterns
- **Each command or component**: usage, flags, behaviour (step-by-step), exit codes, error messages
- **Data formats**: schemas, wire protocols, file formats
- **Edge cases**: what happens when things go wrong — be explicit

## Approach

1. Read the relevant design document(s) in `docs/design/`.
2. For each component, write precise behaviour. Use numbered steps. Be specific about error messages and exit codes.
3. Use tables for flags and fields.
4. Include concrete examples (CLI output, JSON payloads) where they clarify.
5. Write the spec in `docs/spec/`. Use the naming convention `NN_Topic.md` matching the design doc.

## Style

- Specs are reference documents. Prioritise precision over narrative.
- Every user-visible behaviour should be specified. If it's not in the spec, it's undefined.
- Error messages should be helpful — include the fix, not just the problem.
- Flag tables should include: name, required/optional, default, description.
