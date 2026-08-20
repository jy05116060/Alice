// Worktree 隔离开发流工具 schema（阶段 5）。
export const worktreeSchemas = {
  create_worktree: {
    type: 'function',
    function: {
      name: 'create_worktree',
      description: 'Create an isolated git worktree so work happens in a separate directory and the main working tree is never touched. Use it when the user explicitly asks for an isolated worktree, or when you need to change code while the user keeps working in the same repository. Returns the worktree path — pass that path as the cwd/path anchor for the later shell and file calls that belong to this isolated work. With carry_staged, only the repository\'s STAGED changes come along (unstaged and untracked files stay behind); committed history is shared.',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Path inside the target git repository (its root is resolved from here). Defaults to the current working directory.',
          },
          branch_name: {
            type: 'string',
            description: 'Branch for the isolated work. A "blm/" prefix is added when the name has no "/". For example "fix-login" becomes "blm/fix-login".',
          },
          path: {
            type: 'string',
            description: 'Where to put the worktree. Defaults to a sibling directory "<repo>.worktrees/<branch>", deliberately outside the repository so the main tree cannot see the isolated copy.',
          },
          carry_staged: {
            type: 'boolean',
            description: 'Bring the repository\'s staged changes into the new worktree (still staged there). Unstaged and untracked changes always stay in the original repository. Defaults to false.',
          },
        },
        required: ['branch_name'],
      },
    },
  },

  checkout_worktree: {
    type: 'function',
    function: {
      name: 'checkout_worktree',
      description: 'Bring an isolated worktree back into the local repository, then remove it. Committed work is always carried (the local branch is created or moved to point at the worktree\'s commits); with carry_staged the worktree\'s staged changes are applied on top. The repository is only switched to the branch when its working tree is clean — if it is not, the branch is still created and you are told why it was not switched. Refuses to remove a worktree that has uncommitted work that would be lost unless force is true.',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Path inside the target git repository. Defaults to the current working directory.',
          },
          worktree_path: {
            type: 'string',
            description: 'The worktree to bring back, as returned by create_worktree. May be omitted if exactly one worktree created in this session is still open.',
          },
          branch_name: {
            type: 'string',
            description: 'Local branch to create or switch to. Defaults to the worktree\'s own branch name.',
          },
          carry_staged: {
            type: 'boolean',
            description: 'Apply the worktree\'s staged changes into the repository after the worktree is removed. Without it, staged-only work in the worktree would be destroyed with it. Defaults to false.',
          },
          force: {
            type: 'boolean',
            description: 'Remove the worktree even though it has uncommitted work that would be destroyed. Use only when the user has explicitly accepted losing it. Defaults to false.',
          },
        },
        required: [],
      },
    },
  },
  // 2026-09-29 补：executor.js 与 tool-policy.js 早就登记了 git_worktrees，但 schema 漏了
  // ——模型只能看到注册进 schema 表的工具，所以「列出现有工作树」这个能力一直对模型不可见
  // （执行分支成了模型够不着的死路）。补上它，模型才能在创建/回收前先看清实际存在什么。
  git_worktrees: {
    type: 'function',
    function: {
      name: 'git_worktrees',
      description: 'List the git worktrees currently in play: the ones this agent created and registered (each with its path, branch, and whether reclaiming it would destroy uncommitted work), plus any other live worktrees git knows about in this repository. Call it before creating or reclaiming a worktree, so you work from what actually exists instead of assuming.',
      parameters: {
        type: 'object',
        properties: {
          repo: {
            type: 'string',
            description: 'Path inside the target git repository (its root is resolved from here). Defaults to the current working directory.',
          },
        },
        required: [],
      },
    },
  },
}
