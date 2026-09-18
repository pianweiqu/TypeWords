// ============================================================
// useArticleWordLookup —— 点击文章单词弹出查词卡时按单词名查完整 Word
//
// 四级查找（命中即返回）：
//   1. article.newWords        — 本课生词（带完整音标/释义/发音）
//   2. 本地英文合并词典（精确） — public/dicts/en/word/nce-dict.json
//                                （由官方 194 本英文词库合并 + 派生词/缩写补丁，
//                                  33428 词，懒加载一次后缓存到模块级 Map）
//   3. 词形还原回退             — accompanied/actors/larger/don't/o'clock 这类
//                                派生词、缩写、所有格，去掉后缀再查基词
//   4. 兜底空壳 getDefaultWord  — 没收录的词只显示单词本身
//
// 为什么不用"拉全站词库列表再逐本建索引"：
//   英文站 files.typewords.cc 有 194 本英文词库、总量 300MB+，
//   逐本拉取不可接受；故改为构建期合并成单文件随站点发布。
// 用法：
//   const { getWord, getWordAsync, ensureGlobalIndex } = useArticleWordLookup(article, language)
// ============================================================
import type { Article, Word } from '../types'
import { getDefaultWord } from '../types'
import { withAppBaseURL } from '../utils/base-url'

export interface AnchorRect {
  top: number
  left: number
  width: number
  height: number
  bottom: number
  right: number
}

// 本地合并词典的路径（随站点 public/ 发布，同源，不受远程 OSS 权限限制）
const LOCAL_DICT_PATH = '/dicts/en/word/nce-dict.json'

// 模块级缓存：Map<wordLowercase, Word>
const LOCAL_DICT_CACHE = new Map<string, Word>()
let LOCAL_DICT_PROMISE: Promise<Map<string, Word>> | null = null
let LOCAL_DICT_LOADED = false

// 归一：把 `phonetic` 映射到 `phonetic0`，保证音标能显示出来
function normalizeWord(w: any): Word {
  if (!w || !w.word) return w
  const out: any = { ...w }
  if (!out.phonetic0 && out.phonetic) out.phonetic0 = out.phonetic
  if (!Array.isArray(out.trans)) out.trans = []
  return out as Word
}

// 词典文件是紧凑数组格式：[ [word, phonetic0, phonetic1, [[pos, cn], ...]], ... ]
// 同时兼容标准对象数组，便于以后换格式。
function extractWords(payload: any): Word[] {
  if (!payload) return []
  let arr: any[] = []
  if (Array.isArray(payload)) arr = payload
  else if (Array.isArray(payload.words)) arr = payload.words
  else if (Array.isArray(payload.list)) arr = payload.list
  else return []

  const out: Word[] = []
  for (const item of arr) {
    if (!item) continue
    if (Array.isArray(item)) {
      const [word, p0, p1, trans] = item
      if (!word) continue
      out.push(
        normalizeWord({
          word,
          phonetic0: p0 || '',
          phonetic1: p1 || '',
          trans: (trans || []).map((t: any) => ({ pos: t?.[0] || '', cn: t?.[1] || '' })),
        })
      )
    } else if (item.word) {
      out.push(normalizeWord(item))
    }
  }
  return out
}

async function loadLocalDict(): Promise<Map<string, Word>> {
  if (LOCAL_DICT_LOADED) return LOCAL_DICT_CACHE
  if (LOCAL_DICT_PROMISE) return LOCAL_DICT_PROMISE

  LOCAL_DICT_PROMISE = (async () => {
    try {
      const r = await fetch(withAppBaseURL(LOCAL_DICT_PATH))
      if (r.ok) {
        const words = extractWords(await r.json())
        for (const w of words) {
          if (w && w.word && !LOCAL_DICT_CACHE.has(w.word.toLowerCase())) {
            LOCAL_DICT_CACHE.set(w.word.toLowerCase(), w)
          }
        }
      }
    } catch (e) {
      // 词典缺失/不可用时静默降级：仍能显示本课生词与空壳，不影响主流程
      console.warn('[wordLookup] 本地英文词典加载失败', e)
    } finally {
      LOCAL_DICT_LOADED = true
      LOCAL_DICT_PROMISE = null
    }
    return LOCAL_DICT_CACHE
  })()

  return LOCAL_DICT_PROMISE
}

// ------------------------------------------------------------
// 词形还原：生成"可能的基词"候选，按可能性从高到低排列。
// 只做后缀剥离，不做词典校验（调用方拿去查表，查不到就下一个）。
// 覆盖：复数/三单 -s -es -ies、过去式 -ed -ied、现在分词 -ing、
//       比较级/最高级 -er -est、副词 -ly、所有格 -'s、
//       缩写 -n't、双写辅音（running→run / stopped→stop）
// ------------------------------------------------------------
const DOUBLE_CONSONANT_RE = /([bdfglmnprt])\1$/

export function inflectCandidates(surface: string): string[] {
  const w = surface.toLowerCase()
  if (!w || w.length < 3) return []

  const out: string[] = []
  const seen = new Set<string>([w])
  const add = (s: string) => {
    if (!s || s.length < 2 || seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  // 双写辅音还原：runn -> run / stopp -> stop
  const addDeduped = (s: string) => {
    add(s)
    if (DOUBLE_CONSONANT_RE.test(s)) add(s.slice(0, -1))
  }

  // 缩写 / 所有格
  if (w.endsWith("n't")) {
    add(w.slice(0, -3))
    add(w.slice(0, -2))
  }
  if (w.endsWith("'s") || w.endsWith("s'")) add(w.slice(0, -2))

  // 复数 / 第三人称单数
  if (w.endsWith('ies')) {
    add(w.slice(0, -3) + 'y') // cities -> city
    add(w.slice(0, -1))
  }
  if (w.endsWith('es')) add(w.slice(0, -2))
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) add(w.slice(0, -1))

  // 现在分词
  if (w.endsWith('ing') && w.length > 4) {
    add(w.slice(0, -3) + 'e') // riding -> ride / changing -> change
    addDeduped(w.slice(0, -3)) // walking -> walk / running -> run
  }

  // 过去式 / 过去分词
  if (w.endsWith('ed') && w.length > 3) {
    if (w.endsWith('ied')) add(w.slice(0, -3) + 'y') // studied -> study
    add(w.slice(0, -1)) // changed -> change / liked -> like
    addDeduped(w.slice(0, -2)) // walked -> walk / stopped -> stop
  }

  // 比较级 / 最高级
  if (w.endsWith('est') && w.length > 4) {
    add(w.slice(0, -2)) // largest -> large
    addDeduped(w.slice(0, -3)) // biggest -> big
    add(w.slice(0, -1))
  } else if (w.endsWith('er') && w.length > 3) {
    add(w.slice(0, -1)) // larger -> large
    addDeduped(w.slice(0, -2)) // bigger -> big
  }

  // 副词
  if (w.endsWith('ily') && w.length > 4) {
    add(w.slice(0, -3) + 'y') // happily -> happy
  }
  if (w.endsWith('ly') && w.length > 3) {
    add(w.slice(0, -2)) // quickly -> quick
  }

  return out
}

export function useArticleWordLookup(article: Article, language?: string) {
  // Tier 1: 本课生词（同步）
  const localMap = new Map<string, Word>()
  for (const w of (article?.newWords || []) as Word[]) {
    if (w && w.word) localMap.set(w.word.toLowerCase(), w)
  }

  const enabled = !language || language === 'en'

  // 在给定表里精确查；未命中则按词形还原候选逐个再查
  function lookupIn(map: Map<string, Word>, text: string): Word | undefined {
    const hit = map.get(text.toLowerCase())
    if (hit) return hit
    for (const cand of inflectCandidates(text)) {
      const c = map.get(cand)
      if (c) return c
    }
    return undefined
  }

  function getWord(text: string): Word {
    if (!text) return getDefaultWord({ word: '' })
    // Tier 1: 本课生词
    const local = lookupIn(localMap, text)
    if (local) return local
    // Tier 2/3: 本地合并词典（未就绪时只读 cache，异步版会等它）
    if (enabled) {
      const dict = lookupIn(LOCAL_DICT_CACHE, text)
      if (dict) return dict
    }
    // Tier 4: 兜底空壳
    return getDefaultWord({ word: text })
  }

  // 异步版本：返回 Promise，本地词典未就绪时会等它加载完再查
  async function getWordAsync(text: string): Promise<Word> {
    if (!text) return getDefaultWord({ word: '' })
    const local = lookupIn(localMap, text)
    if (local) return local
    if (enabled) {
      const idx = await loadLocalDict()
      const hit = lookupIn(idx, text)
      if (hit) return hit
    }
    return getDefaultWord({ word: text })
  }

  // 预热：进入文章页时立即开始加载，用户点单词时大概率已就绪
  function ensureGlobalIndex(): void {
    if (!enabled) return
    if (LOCAL_DICT_LOADED) return
    loadLocalDict().catch(() => {
      /* swallow */
    })
  }

  return { getWord, getWordAsync, ensureGlobalIndex }
}
