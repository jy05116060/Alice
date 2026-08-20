import { createPendingInteraction } from '../../interaction/pending.js'
import { getSSEClientCount } from '../../events.js'

// ask_user_question 的执行体：发出提问卡，挂起等用户作答。
// 答案以普通工具结果回到模型手里——和 DSH 的 dsh-tool-ask-user 一致。

function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((option) => {
      const label = String(option?.label ?? '').trim()
      if (!label) return null
      const description = typeof option?.description === 'string' && option.description.trim()
        ? option.description.trim()
        : undefined
      return { label, ...(description === undefined ? {} : { description }) }
    })
    .filter(Boolean)
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const questions = []
  for (const entry of raw) {
    const id = String(entry?.id ?? '').trim()
    const question = String(entry?.question ?? '').trim()
    if (!id || !question || seen.has(id)) continue
    seen.add(id)
    const header = typeof entry?.header === 'string' && entry.header.trim() ? entry.header.trim() : undefined
    const options = normalizeOptions(entry?.options)
    questions.push({
      id,
      question,
      ...(header === undefined ? {} : { header }),
      ...(options.length === 0 ? {} : { options }),
      multiSelect: entry?.multi_select === true,
    })
  }
  return questions
}

export async function execAskUserQuestion(args = {}, context = {}) {
  const questions = normalizeQuestions(args.questions)
  if (questions.length === 0) {
    return JSON.stringify({
      ok: false,
      code: 'EMPTY_QUESTIONS',
      error: 'ask_user_question requires at least one question carrying both an id and a question text',
    })
  }

  // 安全阀（与 approval-gate 同一约定）：没有 brain-ui 连着时不挂起。
  // 提问卡只能在 UI 上渲染，没客户端时挂起只会让整轮对话白等到超时——
  // 那种情况下立刻把错误还给模型，让它换条路走更诚实。
  if (getSSEClientCount() === 0) {
    return JSON.stringify({
      ok: false,
      code: 'NO_UI',
      error: 'ask_user_question cannot suspend without a connected Brain UI client',
    })
  }

  const pending = createPendingInteraction({
    kind: 'question',
    toolName: 'ask_user_question',
    questions,
  })

  const signal = context?.signal
  const onAbort = () => pending.cancel('工具调用已中断')
  if (signal) {
    if (signal.aborted) {
      pending.cancel('工具调用已中断')
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  try {
    const answer = await pending.result
    return JSON.stringify({ ok: true, answers: answer.answers })
  } catch (err) {
    return JSON.stringify({
      ok: false,
      code: err?.code || 'ASK_ABORTED',
      error: err?.message || 'ask_user_question was cancelled before the user answered',
    })
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
