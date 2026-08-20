// 工作流工具 schema（阶段 2，对齐 DSH `dsh-tool-workflow`）。
// 描述里必须把脚本契约讲清楚——模型看不到 DSH 的文档，只会读这段文字。
export const workflowSchemas = {
  workflow: {
    type: 'function',
    function: {
      name: 'workflow',
      description: [
        'Run a JavaScript workflow script that fans work out across sub-agents. Use it for work that splits into many independent pieces (an audit over many files, a migration, multi-angle research, adversarial verification) where you would otherwise write the orchestration turn by turn.',
        'For one or two delegations use run_subagent instead — a workflow costs more than it saves at that scale.',
        '',
        'The script is plain JavaScript (top-level await is fine), NOT TypeScript. It has no filesystem, network, timer, or Node.js APIs — the agents do the work. Only these hooks exist:',
        '  • await agent(prompt, opts?) — run one sub-agent to completion. Without opts.schema it resolves to the child\'s final text; with an object-rooted opts.schema it resolves to the validated object. Resolves null when that child fails (use .filter(Boolean)). opts: { schema, label, phase, model }.',
        '  • await parallel(thunks) — array of zero-argument functions, run concurrently, awaits ALL (a barrier). A throwing thunk resolves to null.',
        '  • await pipeline(items, ...stages) — each item runs through the stages independently with NO barrier between stages, so slow items do not block others. Each stage receives (prev, item, index); the first stage\'s prev is the item. A throwing stage drops that item to null and skips its remaining stages.',
        '  • phase(title) — group subsequent agents under a progress label.',
        '  • log(message) — narrate progress.',
        '  • args — the args value you passed to this tool, verbatim.',
        '',
        'Discipline: a mistyped option, an unsupported schema, or a tripped cap kills the whole script loudly; an ordinary child failure or a throwing stage only nulls that one item. Agent caps: 8 concurrent, 64 total per run.',
        'End the script with `return <value>`; the JSON-serializable value becomes this tool result. Return only plain JSON data (no functions, Dates, Maps, undefined, NaN, or cycles).',
        '',
        'Background mode: pass run_in_background=true when the fan-out will outlast a sensible wait. It returns immediately with a run id and does NOT block this turn; the run keeps going on its own. Poll it with workflow_status(action="status", run_id=...) and only use the result once its status is "completed" or "error". A background run does not wait for this turn and does not share this turn\'s sub-agent slots, but it still counts against the same per-run agent caps (8 concurrent, 64 total). At most 4 background workflows run at once per process; the engine reuses its own concurrency slots, so a background run cannot exceed the run\'s maxConcurrentAgents either.',
        'Run state lives in memory only — workflow_status only sees runs from the current process and a restart clears that history. Do not treat a run id as a durable handle across restarts.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'The plain-JavaScript workflow body. Top-level await allowed. End with `return <json-serializable value>`. Do not include `export` statements.',
          },
          meta: {
            type: 'object',
            description: 'Workflow identity.',
            properties: {
              name: { type: 'string', description: 'Short kebab-case name, e.g. "audit-repos".' },
              description: { type: 'string', description: 'One-line description of what the workflow does.' },
              whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
              phases: {
                type: 'array',
                description: 'Optional declared phases; must match the phase() calls in the script.',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                  },
                  required: ['title'],
                },
              },
            },
            required: ['name', 'description'],
          },
          args: {
            type: 'object',
            description: 'Optional JSON input exposed to the script as the `args` global.',
          },
          run_in_background: {
            type: 'boolean',
            description: 'Default false. When true the tool returns immediately with a run id instead of waiting for the workflow to finish, and the run continues in the background — query it with workflow_status(action="status", run_id=...). Use it for long fan-outs where you have other work to do; do not poll in a tight loop. The registry is in-memory: the run is only queryable in this process, and a restart clears it.',
          },
        },
        required: ['script', 'meta'],
      },
    },
  },

  workflow_status: {
    type: 'function',
    function: {
      name: 'workflow_status',
      description: [
        'Read the state of workflow runs from this process: one run by id, or the recent list. Use it after calling workflow with run_in_background=true, and any time you need to check whether a fan-out finished.',
        'action="status" needs run_id and returns the run-level status ("running" / "completed" / "error"), the failure code and message when it failed, per-phase and per-item results, agent counts, duration and the last log lines. action="list" (default limit 10) returns the most recent runs, newest first, with how many are still running.',
        'Honesty about scope: the run registry is IN-MEMORY ONLY. A run is queryable only inside the process that started it — it is not persisted, a restart clears it, and there is no history from previous sessions. An unknown run id means "not in this process" (wrong id, or the process restarted), not "still running". Do not treat this as a durable job queue.',
        'This tool only reads. There is no cancel action — a background run finishes on its own deadline.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'list'],
            description: 'Default "status": look up one run by run_id. "list": the recent runs in this process.',
          },
          run_id: {
            type: 'string',
            description: 'action="status": the run id returned by the workflow tool (looks like wf-<time>-<n>).',
          },
          limit: {
            type: 'integer',
            description: 'action="list": how many recent runs to return (1-50, default 10).',
          },
        },
        required: [],
      },
    },
  },
}
