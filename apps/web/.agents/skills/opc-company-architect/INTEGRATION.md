# Runtime integration

OPC Studio uses one canonical versioned Skill:

`apps/server/src/runtime/companyArchitectSkill.ts`

`architectAssistant.ts` imports that artifact directly and records its `id` and `version` on generated proposals. This directory is a developer adapter and supporting reference only; it intentionally does not duplicate the runtime prompt.

Changes to company-design behavior must update the canonical module and its tests. User-managed Skill records, employee personas, and memory cannot override or disable this control-plane Skill.