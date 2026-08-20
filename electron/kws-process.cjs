// kws-process.cjs —— 语音唤醒(KWS)子进程,跑在 Electron utilityProcess 里
//
// 为什么要独立进程:sherpa-onnx 自带一份 onnxruntime,而后端 @huggingface/transformers
// 走 onnxruntime-node 另带一份;同一进程加载两份 onnxruntime 会在构建会话时原生崩溃
// (已用 probe 坐实)。把 KWS 隔离到只加载 sherpa 的独立进程,从根上消除冲突。
//
// 协议(parentPort):
//   收 {type:'init', modelDir, logFile}  → 构建 KeywordSpotter,回 {type:'ready'} / {type:'error'}
//   收 {type:'pcm',  buf:ArrayBuffer}    → 喂 16kHz Float32,命中则写日志 + 回 {type:'hit', keyword}
const fs = require('fs')
const path = require('path')

const KEYWORDS_THRESHOLD = 0.35 // 从 0.25 上调到 0.35，减少误触发
const KEYWORDS_SCORE = 3.0      // 实测 score=3 召回最佳(13/17 vs 2.0 的 9/17)
const COOLDOWN_MS = 800 // 命中后冷却:去重一次唤醒的多帧结果,又允许~1s 间隔的重试都触发

let spotter = null
let stream = null
let sherpa = null
let logFile = null