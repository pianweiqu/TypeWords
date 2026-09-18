<script setup lang="ts">
// ============================================================
// WordDefinePopover —— 点击文章单词时弹出的查词卡
// 复用 @typewords/core/components/word/WordItem 作为内容（自带音标+喇叭+按词性分组释义+收藏星标）
// Teleport 到 body；fixed 定位，默认在单词上方；顶部空间不够自动翻到下方
// 关闭：右上角 × / Esc / 点击弹层外（用 capture+mousedown 配合父级 .stop 防止误关）
//
// 异步补全：父级传入的 word 可能是同步查到的"空壳"（没命中本课 newWords，
// 全局语言词库还没加载完）。本组件会监听 word 变化触发 async 重新解析，
// 拿到完整数据后自动替换 word，实现"先弹卡片占位 + 后台补全释义"。
// ============================================================
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Word } from '../../types'
import type { AnchorRect } from '../../hooks/useArticleWordLookup'
import WordItem from '../word/WordItem.vue'

const props = defineProps<{
  word: Word | null
  anchor: AnchorRect | null
  resolveAsync?: (text: string) => Promise<Word | null>
  queryText?: string
}>()
const emit = defineEmits<{ close: [] }>()

const internalWord = ref<Word | null>(props.word)
watch(
  () => props.word,
  v => {
    internalWord.value = v
    if (v && props.resolveAsync && props.queryText && isStub(v)) {
      triggerAsyncResolve(props.queryText)
    }
  },
  { immediate: true }
)

function isStub(w: Word | null): boolean {
  if (!w) return false
  // 没有音标就算"不完整"——需要异步从全局词库补全音标
  // （即使已有 trans，也允许用全局词库的音标做补全）
  const hasPhonetic = !!(w.phonetic0 || w.phonetic1)
  return !hasPhonetic
}

const asyncLoading = ref(false)
let asyncToken = 0

// 词形还原提示：点击的是派生形式（changed/larger/don't）时，
// 卡片展示的是基词（change/large），这里补一行说明，避免用户困惑。
const baseHint = computed(() => {
  const cur = internalWord.value
  const q = props.queryText
  if (!cur || !cur.word || !q) return ''
  return cur.word.toLowerCase() === q.toLowerCase() ? '' : cur.word
})

async function triggerAsyncResolve(text: string) {
  if (!props.resolveAsync) return
  const myToken = ++asyncToken
  asyncLoading.value = true
  try {
    const fresh = await props.resolveAsync(text)
    if (myToken !== asyncToken) return
    if (!fresh || isStub(fresh)) return
    const cur = internalWord.value
    const sameWord =
      !!cur && !!cur.word && !!fresh.word && cur.word.toLowerCase() === fresh.word.toLowerCase()
    if (sameWord && !cur!.phonetic0 && !cur!.phonetic1 && (fresh.phonetic0 || fresh.phonetic1)) {
      // 当前词已有释义（来自本课 newWords），只是缺音标 → 仅补全音标，保留原释义
      internalWord.value = {
        ...cur!,
        phonetic0: cur!.phonetic0 || fresh.phonetic0,
        phonetic1: cur!.phonetic1 || fresh.phonetic1,
      }
    } else if (!cur || isStub(cur)) {
      // 完全空白的 stub（连 trans 都没有）→ 用全局完整词替换
      internalWord.value = fresh
    }
  } catch (e) {
    console.error('[WordDefinePopover] async resolve failed', e)
  } finally {
    if (myToken === asyncToken) asyncLoading.value = false
  }
}

const tipEl = ref<HTMLDivElement | null>(null)
const pos = ref<{ top: number; left: number; placement: 'top' | 'bottom' }>({
  top: -9999,
  left: 0,
  placement: 'top',
})

function place() {
  if (!props.anchor || !tipEl.value) return
  const tip = tipEl.value.getBoundingClientRect()
  const w = tip.width
  const h = tip.height
  const a = props.anchor
  const gap = 8
  const pad = 8
  let top = a.top - h - gap
  let placement: 'top' | 'bottom' = 'top'
  if (top < pad) {
    top = a.bottom + gap
    placement = 'bottom'
  }
  // 底部约束：卡片底部超出视口时尽量上移；仍超出则贴底（配合 max-height+overflow 可滚动查看）
  if (top + h > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - h - pad)
  }
  let left = a.left + a.width / 2 - w / 2
  if (left < pad) left = pad
  if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad
  pos.value = { top, left, placement }
}

watch(
  [() => props.anchor, () => internalWord.value],
  () => nextTick(place),
  { immediate: true }
)

function onDocMouseDown(e: MouseEvent) {
  const t = e.target as Node | null
  if (tipEl.value && t && !tipEl.value.contains(t)) emit('close')
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
function onScrollOrResize() {
  emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onScrollOrResize)
  window.addEventListener('scroll', onScrollOrResize, true)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onScrollOrResize)
  window.removeEventListener('scroll', onScrollOrResize, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="internalWord"
      ref="tipEl"
      class="word-define-popover"
      :style="{ top: pos.top + 'px', left: pos.left + 'px' }"
      :data-placement="pos.placement"
      @click.stop
      @mousedown.stop
      @contextmenu.prevent
    >
      <button
        type="button"
        class="wdp-close"
        :title="'关闭'"
        aria-label="close"
        @click="emit('close')"
      >×</button>
      <span v-if="asyncLoading" class="wdp-loading" title="正在补全释义…">⏳</span>
      <div v-if="baseHint" class="wdp-base">
        {{ queryText }} <span class="wdp-arrow">→</span> 原形 <b>{{ baseHint }}</b>
      </div>
      <WordItem :item="internalWord" :show-mark-icon="false" />
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.word-define-popover {
  position: fixed;
  z-index: 9999;
  background: var(--color-tooltip-bg);
  color: inherit;
  border-radius: 0.5rem;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
  padding: 0.55rem 0.9rem 0.7rem;
  // 窄屏下用视口宽度兜底，避免固定 18rem/30rem 在手机上溢出
  min-width: min(18rem, 92vw);
  max-width: min(30rem, 92vw);
  // 释义/例句较长时限制高度并允许内部滚动，避免手机上底部被裁切
  max-height: calc(100vh - 1rem);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  animation: wdp-pop 0.12s ease-out;

  &::after {
    content: '';
    position: absolute;
    width: 0;
    height: 0;
    border: 6px solid transparent;
    pointer-events: none;
  }
  &[data-placement='top']::after {
    bottom: -12px;
    left: 50%;
    transform: translateX(-50%);
    border-top-color: var(--color-tooltip-bg);
  }
  &[data-placement='bottom']::after {
    top: -12px;
    left: 50%;
    transform: translateX(-50%);
    border-bottom-color: var(--color-tooltip-bg);
  }
}

.wdp-close {
  position: absolute;
  top: 0.2rem;
  right: 0.3rem;
  width: 1.5rem;
  height: 1.5rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  border-radius: 9999px;
  cursor: pointer;
  font-size: 1.15rem;
  line-height: 1;
  color: var(--color-font-mute, #888);
  transition: background 0.12s;
  &:hover {
    background: rgba(0, 0, 0, 0.08);
    color: inherit;
  }
}

.wdp-base {
  margin: 0 0 0.35rem;
  padding-right: 2.2rem;
  font-size: 0.78rem;
  line-height: 1.3;
  color: var(--color-font-mute, #888);

  b {
    color: inherit;
    font-weight: 600;
  }

  .wdp-arrow {
    opacity: 0.7;
    margin: 0 0.15rem;
  }
}

.wdp-loading {
  position: absolute;
  top: 0.2rem;
  right: 2rem;
  font-size: 0.95rem;
  line-height: 1;
  opacity: 0.6;
  animation: wdp-spin 1.2s linear infinite;
  display: inline-block;
  pointer-events: none;
}

@keyframes wdp-spin {
  to { transform: rotate(360deg); }
}

@keyframes wdp-pop {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
</style>
