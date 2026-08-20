// 子代理类工具 schema：run_subagent / spawn_subagent / subagent_message /
// subagent_interrupt / subagent_list（阶段 1，对齐 DSH dsh-tool-subagent）。
// 字段名与 DSH 保持一致，便于迁移与复用同一套心智模型。
export const subagentSchemas = {
  run_subagent: {
    type: 'function',
    function: {
      name: 'run_subagent',
      description: 'Delegate a self-contained task to an in-process sub-agent that runs with its own conversation and a small tool set, then returns its final answer. Use it to offload focused, independent work (research, a scoped implementation, an analysis) so it does not consume this conversation. For one or two delegations prefer this tool; for large fan-out work use workflow. The sub-agent cannot message the user and cannot ask you questions — write a complete, self-contained prompt.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The complete, self-contained task for the sub-agent. It does not share this conversation, so include everything it needs.',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 word) label for display.',
          },
          model: {
            type: 'string',
            description: 'Optional model override. Must belong to the currently configured provider.',
          },
          result_schema: {
            type: 'object',
            description: 'Optional JSON Schema (object-rooted). When given, the sub-agent must finish with a JSON value satisfying it, and the validated value is returned instead of prose. Supported keywords: type, properties, required, additionalProperties, items, enum, const, oneOf.',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tool-name override for the sub-agent. Defaults to a safe set (file read/write, command, web, memory). Communication, delegation, install and browser-takeover tools are never available to sub-agents.',
          },
          inherit_context: {
            type: 'boolean',
            description: 'When true, the sub-agent starts from this conversation\'s completed turns (a fork). Defaults to false: a fresh sub-agent that only sees your prompt.',
          },
        },
        required: ['prompt'],
      },
    },
  },

  spawn_subagent: {
    type: 'function',
    function: {
      name: 'spawn_subagent',
      description: 'Start a continuable sub-agent: it runs the first task and keeps its conversation, so you can send it follow-up messages later with subagent_message. Choose this when the work needs several rounds (review, then revise, then re-check); choose run_subagent for a single result.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The first task for the sub-agent. Include everything it needs, since it does not share this conversation.',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 word) label for display.',
          },
          model: {
            type: 'string',
            description: 'Optional model override. Must belong to the currently configured provider.',
          },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tool-name override for the sub-agent. Defaults to the safe set.',
          },
          inherit_context: {
            type: 'boolean',
            description: 'When true, the sub-agent starts from this conversation\'s completed turns (a fork). Defaults to false.',
          },
        },
        required: ['prompt'],
      },
    },
  },

  subagent_message: {
    type: 'function',
    function: {
      name: 'subagent_message',
      description: 'Send a follow-up message to a continuable sub-agent and get its answer. If it is currently working, the message is queued and runs right after its current turn (nothing is lost).',
      parameters: {
        type: 'object',
        properties: {
          child_id: {
            type: 'string',
            description: 'The sub-agent id returned by spawn_subagent (or seen in subagent_list).',
          },
          message: {
            type: 'string',
            description: 'The follow-up instruction for the sub-agent.',
          },
        },
        required: ['child_id', 'message'],
      },
    },
  },

  subagent_interrupt: {
    type: 'function',
    function: {
      name: 'subagent_interrupt',
      description: 'Stop a running sub-agent (drops its queued messages), or forget a finished one and delete its saved conversation.',
      parameters: {
        type: 'object',
        properties: {
          child_id: {
            type: 'string',
            description: 'Target sub-agent id.',
          },
          action: {
            type: 'string',
            enum: ['interrupt', 'forget'],
            description: 'interrupt (default) stops the running turn; forget also deletes the saved conversation.',
          },
        },
        required: ['child_id'],
      },
    },
  },

  subagent_list: {
    type: 'function',
    function: {
      name: 'subagent_list',
      description: 'List sub-agents with their mode, status and queued-message count, without loading or waking them.',
      parameters: {
        type: 'object',
        properties: {
          include_done: {
            type: 'boolean',
            description: 'Also list finished sub-agents. Defaults to false.',
          },
        },
      },
    },
  },
}
