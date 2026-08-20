// present 交付物工具 schema（阶段 6.2）。
export const presentSchemas = {
  present: {
    type: 'function',
    function: {
      name: 'present',
      description: 'Declare finished files as deliverables so they show up as cards the user can open with one click (Office documents, spreadsheets, slide decks, PDFs, images, archives, reports). Use it when the user is meant to take a file away and open it themselves — not for files you only read, and not as a way to list what you did. The files must already exist. Pass at most 4, most important first; if your reply alone already says everything the user needs, prefer the reply. The contents are not copied or inlined, so still write the important conclusions in your normal reply — the card is for opening the file, not for reading it out.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'The deliverables, most important first (at most 4).',
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Path to an existing file. Relative paths resolve against the working root, same as the file and shell tools.',
                },
                description: {
                  type: 'string',
                  description: 'One short line telling the user what this file is or what to do with it. Shown on the card under the file name.',
                },
              },
              required: ['path'],
            },
          },
        },
        required: ['files'],
      },
    },
  },
}
