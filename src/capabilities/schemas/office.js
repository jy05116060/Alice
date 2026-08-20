// convert_to_pdf 工具 schema（阶段 6.3）。
export const officeSchemas = {
  convert_to_pdf: {
    type: 'function',
    function: {
      name: 'convert_to_pdf',
      description: 'Convert office documents (doc/docx/odt/rtf/txt, xls/xlsx/ods/csv, ppt/pptx/odp) to PDF using the LibreOffice installed on this machine. Use it when the user needs a PDF of a document you produced or one they gave you, then hand the result over with present. The PDF is written next to the source file unless out_dir says otherwise. The original file is left untouched. If no converter is installed this reports exactly that instead of guessing — in that case say so to the user rather than retrying.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            description: 'Files to convert (at most 10). Convert them in one call — the converter startup dominates the cost.',
            items: { type: 'string' },
          },
          out_dir: {
            type: 'string',
            description: 'Directory to write the PDFs into. Defaults to each source file\'s own directory.',
          },
        },
        required: ['paths'],
      },
    },
  },
  office_capability: {
    type: 'function',
    function: {
      name: 'office_capability',
      description: 'Check whether this machine has an office converter available for convert_to_pdf. Call it when you are about to promise the user a PDF and want to know it is possible, so you can tell them up front instead of failing later.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
}
