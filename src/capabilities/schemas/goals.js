// 长期目标类工具 schema（阶段 3.1，对齐 DSH create_goal / update_goal / get_goal）。
export const goalSchemas = {
  create_goal: {
    type: 'function',
    function: {
      name: 'create_goal',
      description: [
        'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the user\'s request is a long-running objective — something that will not finish inside this turn and that you should keep pushing forward on your own (a migration, a research thread, "keep improving X until it meets Y").',
        'Do NOT use it for a single-turn task, and do not use it for a step list you will finish now — that is set_task. A goal survives restarts, and rounds are spent automatically, so creating one is a standing commitment to keep working.',
        'The runtime disarms a goal whenever the process restarts: after a restart nothing continues until the user asks to continue, at which point you rearm it with update_goal action=resume.',
        'Only one goal can be open at a time. If the user changed what the objective is, use update_goal action=edit instead of creating a second goal.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            description: 'The concrete completion objective, in one or two sentences. Write it so a fresh round can judge whether it is achieved.',
          },
          max_rounds: {
            type: 'integer',
            description: 'How many automatic continuation rounds you may spend on this before it stops and waits for the user. Defaults to the configured budget.',
          },
          progress_note: {
            type: 'string',
            description: 'Optional: where things stand right now, so the first automatic round does not re-derive it.',
          },
        },
        required: ['objective'],
      },
    },
  },

  update_goal: {
    type: 'function',
    function: {
      name: 'update_goal',
      description: [
        'Change the open goal. Always pass the exact revision you read (from get_goal, or from the revision line in an automatic goal round): the goal may have moved on, and a stale revision is rejected rather than overwriting newer state.',
        'Actions:',
        '  • note — record where the objective now stands (progress_note). Allowed in automatic rounds; this is how the next round knows where you left off.',
        '  • complete — the objective is achieved. Allowed in automatic rounds.',
        '  • blocked — the same blocking condition has persisted for at least 3 rounds and needs blocked_reason. Allowed in automatic rounds only after that many rounds.',
        '  • edit / pause / resume — these change what the goal is or whether it continues, so they require a direct user request. Resume also rearms the goal and resets the round budget.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          goal_id: { type: 'string', description: 'The goal id (from get_goal). Defaults to the only open goal.' },
          revision: { type: 'integer', description: 'The exact revision you read. Required.' },
          action: {
            type: 'string',
            enum: ['edit', 'note', 'pause', 'resume', 'complete', 'blocked'],
            description: 'What to change.',
          },
          objective: { type: 'string', description: 'action=edit: the new objective text.' },
          progress_note: { type: 'string', description: 'action=note: where the objective now stands, in one or two lines.' },
          blocked_reason: { type: 'string', description: 'action=blocked: the concrete condition that persists and prevents progress.' },
          pause_reason: { type: 'string', description: 'action=pause: why it is stopping.' },
        },
        required: ['revision', 'action'],
      },
    },
  },

  get_goal: {
    type: 'function',
    function: {
      name: 'get_goal',
      description: 'Read the open goal: objective, status, revision, rounds spent, and where the last round left off. Call it before update_goal — you need the current revision.',
      parameters: {
        type: 'object',
        properties: {
          include_finished: { type: 'boolean', description: 'Also list recently finished goals.' },
        },
      },
    },
  },
}
