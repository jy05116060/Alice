// Scene 工具 schema —— ui_set(Agent 驱动 UI 的唯一入口,声明式)。
// 协议见仓库根目录 SCENE-PROTOCOL.md。
export const sceneSchemas = {
  ui_set: {
    type: 'function',
    function: {
      name: 'ui_set',
      description: [
        'Declare what a single UI surface should be right now. This is the ONE verb for driving the interface: you describe desired state, not commands.',
        'Idempotent: reusing the same id updates that surface in place; a new id adds a new surface; pass remove=true to take it away.',
        'You describe semantic content and importance only — never pixels, position, size, or animation. The interface owns all presentation and transitions.',
        'Use a surface when structured/visual expression is clearer than text; prefer staying silent otherwise. Still give a short text reply alongside.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Stable surface identity. Same id = update in place (and lets the UI animate it as the same element); new id = new surface. Required.',
          },
          kind: {
            type: 'string',
            description: 'What to render, from the renderer vocabulary: text, metric, image, media, choice, weather; or layout primitives stack / row / col to compose the long tail. Required unless remove=true.',
          },
          data: {
            type: 'object',
            description: 'Semantic content for this kind, pure data (no styling). E.g. weather: { city, temp, condition, forecast }; choice: { prompt, options:[{value,label}] }; text: { title, body }. See SCENE-PROTOCOL kind table.',
          },
          intent: {
            type: 'string',
            enum: ['ambient', 'inform', 'confront'],
            description: 'Semantic importance, NOT placement. ambient = fades by in a corner; inform = normal (default); confront = user must stop and look / decide.',
          },
          focus: {
            type: 'boolean',
            description: 'Whether this surface is the current focus. At most one focused surface at a time.',
          },
          order: {
            type: 'number',
            description: 'Optional sort weight among surfaces; lower comes first.',
          },
          remove: {
            type: 'boolean',
            description: 'Set true to remove the surface with this id, instead of showing/updating it.',
          },
        },
        required: ['id'],
      },
    },
  },
}
