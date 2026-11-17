export const skillNames = ['triage', 'quote', 'create', 'amend', 'cancel', 'filing'] as const;
export type SkillName = (typeof skillNames)[number];

export const skillReadDefinition = {
  name: 'skill_read',
  description: 'Read a pinned skill or its relative Markdown reference.',
  input_schema: {
    type: 'object' as const,
    properties: {
      skill_name: { type: 'string', enum: [...skillNames] },
      path: { type: 'string' },
    },
    required: ['skill_name'],
    additionalProperties: false,
  },
};
