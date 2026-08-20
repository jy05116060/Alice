import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { resanitizeCapture } = require('../electron/network-audit-utils.cjs')

const input = process.argv[2]
const output = process.argv[3] || input
if (!input) {
  console.error('usage: node scripts/resanitize-network-capture.mjs <input.json> [output.json]')
  process.exit(1)
}

const inputPath = path.resolve(input)
const outputPath = path.resolve(output)
const capture = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const sanitized = resanitizeCapture(capture)
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
const temporary = `${outputPath}.tmp`
fs.writeFileSync(temporary, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 })
fs.renameSync(temporary, outputPath)
console.log(`SANITIZED ${outputPath}`)
