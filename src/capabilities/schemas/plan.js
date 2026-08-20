// 计划模式工具 schema（阶段 3.3）。
// 注意：description 用单引号包裹，所以正文里不能出现撇号（写成 "the user" 而不是 "user's"）。
export const planSchemas = {
  enter_plan_mode: {
    type: 'function',
    function: {
      name: 'enter_plan_mode',
      description: 'Switch to plan mode when the user wants a plan before any change is made ("先给我方案", "别动手，先说怎么做", "design it first"). In plan mode the tools that change anything (writing files, running commands, installing, scheduling, sending anything outward beyond your reply) are unavailable, so you can only explore, ask, and produce a plan that you then submit with exit_plan_mode. Use this the moment the intent reads as "plan first" — before you start editing anything. It only takes effect because the user asked for it; an autonomous turn cannot switch into plan mode.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why plan mode is being entered — what the user said that made "plan first" the right read.',
          },
        },
        required: [],
      },
    },
  },
  exit_plan_mode: {
    type: 'function',
    function: {
      name: 'exit_plan_mode',
      description: 'Submit the finished plan for the user to approve. Call this once the plan is complete and concrete — not to ask a clarifying question (use ask_user_question for that). It renders a review card showing the plan text you pass in; if the user approves, plan mode ends and you execute the plan, and if they send it back with feedback, you stay in plan mode and revise. The plan field is the only place the user sees the plan before deciding, so pass it in full.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description: 'The complete plan, in full. Be concrete: what changes, in what order, which files or systems are involved, what could go wrong, and how it will be verified.',
          },
        },
        required: ['plan'],
      },
    },
  },
}
