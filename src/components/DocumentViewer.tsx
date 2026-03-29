import { useMemo, useRef, useState } from 'react'

import type { DocumentModel, DocumentSectionData } from '../document'
import { LineDiffLegend, LineDiffPanels } from './LineDiffPanels'

const textareaBodyClass =
  'mt-4 w-full resize-y rounded-md border border-transparent bg-gray-50/80 px-3 py-2.5 font-serif text-base leading-relaxed text-gray-800 shadow-inner transition-colors placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20'

const textareaReadOnlyClass =
  'cursor-default border-gray-100 bg-gray-50 text-gray-700 shadow-none hover:border-gray-100 hover:bg-gray-50'

function CoAuthorMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1.5 text-sm text-gray-800">
      {lines.map((line, i) => {
        const t = line.trim()
        if (t.startsWith('## ')) {
          return (
            <h4
              key={i}
              className="mt-3 border-b border-violet-100 pb-1 font-sans text-xs font-bold uppercase tracking-wide text-violet-950 first:mt-0"
            >
              {t.slice(3)}
            </h4>
          )
        }
        if (t.startsWith('- ') || t.startsWith('* ')) {
          return (
            <p key={i} className="ml-1 border-l-2 border-violet-200 pl-3 text-gray-700">
              {t.slice(2)}
            </p>
          )
        }
        if (t === '') return <div key={i} className="h-1" />
        return (
          <p key={i} className="text-gray-700">
            {line}
          </p>
        )
      })}
    </div>
  )
}

type DocumentSectionProps = {
  section: DocumentSectionData
  readOnly: boolean
  compareOfficial?: DocumentModel
  onBodyChange: (sectionId: string, body: string) => void
  coauthorApiBase?: string | null
}

function sectionTitleClass(kind: DocumentSectionData['kind'], wrapClassName?: string): string {
  const base =
    kind === 'hero'
      ? 'mt-6 text-center font-serif text-2xl font-normal text-gray-900'
      : kind === 'note'
        ? 'font-sans text-sm font-semibold text-amber-900'
        : 'font-serif text-xl font-normal text-gray-900'
  return [base, wrapClassName].filter(Boolean).join(' ')
}

function sectionMinHeight(kind: DocumentSectionData['kind']): string {
  if (kind === 'hero') return 'min-h-[min(44rem,72vh)]'
  if (kind === 'note') return 'min-h-[12rem]'
  return 'min-h-[min(36rem,62vh)]'
}

function sectionRows(kind: DocumentSectionData['kind']): number {
  if (kind === 'hero') return 28
  if (kind === 'note') return 10
  return 22
}

function sectionBodyExtraClass(kind: DocumentSectionData['kind'], readOnly: boolean): string {
  if (kind === 'note') {
    return [
      'border-l-2 border-amber-200 bg-amber-50/90 text-gray-800 shadow-none',
      readOnly
        ? 'hover:border-amber-200'
        : 'hover:border-amber-300 focus:border-amber-400 focus:ring-amber-500/20',
    ].join(' ')
  }
  if (readOnly) return textareaReadOnlyClass
  return 'hover:border-gray-200 hover:bg-white focus:border-blue-300 focus:bg-white'
}

function DocumentSection({
  section,
  readOnly,
  compareOfficial,
  onBodyChange,
  coauthorApiBase,
}: DocumentSectionProps) {
  const { id, title, body, kind } = section
  const wrapClass = kind === 'hero' ? undefined : 'mt-10'
  const baseSection = compareOfficial?.sections.find((s) => s.id === id)
  const showLineDiff = Boolean(baseSection && baseSection.body !== body)
  const [coLoading, setCoLoading] = useState(false)
  const [coError, setCoError] = useState<string | null>(null)
  const [coMarkdown, setCoMarkdown] = useState<string | null>(null)
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null)

  const base = coauthorApiBase?.replace(/\/$/, '') ?? ''
  const showCoauthor = Boolean(base)

  async function runCoauthor() {
    if (!base) return
    setCoLoading(true)
    setCoError(null)
    setCoMarkdown(null)
    const el = bodyTextareaRef.current
    let payloadBody = body
    let excerpt = false
    if (el && el.selectionStart !== el.selectionEnd) {
      const a = Math.min(el.selectionStart, el.selectionEnd)
      const b = Math.max(el.selectionStart, el.selectionEnd)
      const slice = body.slice(a, b)
      if (slice.trim()) {
        payloadBody = slice
        excerpt = true
      }
    }
    try {
      const res = await fetch(`${base}/api/coauthor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: payloadBody, excerpt }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; markdown?: string }
      if (!res.ok) {
        setCoError(data.error || res.statusText || 'Request failed')
        return
      }
      if (data.markdown) setCoMarkdown(data.markdown)
      else setCoError('No content in response')
    } catch (e) {
      setCoError(e instanceof Error ? e.message : 'Network error — is the collab server running (npm run collab)?')
    } finally {
      setCoLoading(false)
    }
  }

  return (
    <section className={wrapClass}>
      <h2 className={sectionTitleClass(kind)}>{title}</h2>
      <textarea
        ref={bodyTextareaRef}
        value={body}
        readOnly={readOnly}
        onChange={(e) => onBodyChange(id, e.target.value)}
        className={`${textareaBodyClass} ${sectionMinHeight(kind)} ${sectionBodyExtraClass(kind, readOnly)}`.trim()}
        rows={sectionRows(kind)}
        spellCheck
      />
      {showLineDiff && baseSection ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-950">Line diff vs official</p>
          <div className="mt-3">
            <LineDiffPanels oldText={baseSection.body} newText={body} compact />
          </div>
        </div>
      ) : null}
      {showCoauthor ? (
        <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-violet-950">Co-Author (demo)</p>
            <button
              type="button"
              onClick={() => void runCoauthor()}
              disabled={coLoading || !body.trim()}
              className="rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {coLoading ? 'Analyzing…' : 'Review clause or highlight'}
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-snug text-violet-900/75">
            Select text in the clause first to review only that part; with no selection, the whole clause is reviewed.
          </p>
          {coError ? (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-2 text-xs text-red-800">{coError}</p>
          ) : null}
          {coMarkdown ? (
            <div className="mt-3 rounded-lg border border-violet-100 bg-white p-3 shadow-inner">
              <CoAuthorMarkdown text={coMarkdown} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

type DocumentViewerProps = {
  document: DocumentModel
  readOnly: boolean
  /** When set (e.g. while editing a working copy), changed sections show a line diff under the editor. */
  compareOfficial?: DocumentModel
  onSectionBodyChange: (sectionId: string, body: string) => void
  /** Base URL for collab server (same host serves POST /api/coauthor). */
  coauthorApiBase?: string | null
}

export function DocumentViewer({
  document,
  readOnly,
  compareOfficial,
  onSectionBodyChange,
  coauthorApiBase,
}: DocumentViewerProps) {
  const subtitle = document.documentTitle ?? 'Document'

  const showCompareLegend = useMemo(() => {
    if (!compareOfficial) return false
    return document.sections.some((s) => {
      const b = compareOfficial.sections.find((x) => x.id === s.id)
      return b !== undefined && b.body !== s.body
    })
  }, [compareOfficial, document])

  return (
    <article
      className="mx-auto w-full max-w-3xl min-h-[calc(100dvh-7.5rem)] rounded-lg border border-gray-200 bg-white px-10 py-8 shadow-sm md:px-14 md:py-10"
      aria-label="Document content"
    >
      <div className="max-w-none text-gray-900">
        <p className="text-center text-sm font-sans font-medium uppercase tracking-widest text-gray-500">{subtitle}</p>
        {showCompareLegend ? (
          <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/40 px-3 py-2">
            <LineDiffLegend />
          </div>
        ) : null}

        {document.sections.map((section) => (
          <DocumentSection
            key={section.id}
            section={section}
            readOnly={readOnly}
            compareOfficial={compareOfficial}
            onBodyChange={onSectionBodyChange}
            coauthorApiBase={coauthorApiBase}
          />
        ))}
      </div>
    </article>
  )
}
