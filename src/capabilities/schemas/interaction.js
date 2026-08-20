// 交互类工具 schema：ask_user_question
// 对齐 DeepSeek Harness Desktop 的 dsh-tool-ask-user（字段名逐条照抄，
// 含 options[].description 与 multi_select，前端才能按同一套结构渲染）。
export const interactionSchemas = {
  ask_user_question: {
    type: 'function',
    function: {
      name: 'ask_user_question',
      description: 'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Questions to ask the user before continuing.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Stable id for this question; echoed in the answer.'
                },
                question: {
                  type: 'string',
                  description: 'The specific question to ask the user.'
                },
                header: {
                  type: 'string',
                  description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".'
                },
                options: {
                  type: 'array',
                  description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'Short user-facing option label.'
                      },
                      description: {
                        type: 'string',
                        description: 'One sentence explaining the tradeoff or impact.'
                      }
                    },
                    required: ['label']
                  }
                },
                multi_select: {
                  type: 'boolean',
                  description: 'Whether the user may select more than one option. Defaults to false.'
                }
              },
              required: ['id', 'question']
            }
          }
        },
        required: ['questions']
      }
    }
  }
}
