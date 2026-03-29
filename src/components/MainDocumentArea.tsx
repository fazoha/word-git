import type { DocumentModel, DocumentSectionData, SectionOverlap, WorkingDocumentStatus } from '../document'
import { DocumentViewer } from './DocumentViewer'
import { RebaseOverlapView } from './RebaseOverlapView'
import { ReviewCompareView } from './ReviewCompareView'
import { WorkspaceHeader, type WorkspaceBadgeTone } from './WorkspaceHeader'

export type RebaseSessionState = {
  overlaps: SectionOverlap[]
  draftSections: DocumentSectionData[]
  resolutions: Record<string, 'official' | 'mine' | undefined>
}

type MainDocumentAreaProps = {
  officialDocument: DocumentModel
  activeDocument: DocumentModel
  isWorkingCopy: boolean
  workingStatus: WorkingDocumentStatus | undefined
  readOnly: boolean
  onSectionBodyChange: (sectionId: string, body: string) => void
  acceptedSectionIds: string[]
  rejectedSectionIds: string[]
  onAcceptSection: (sectionId: string) => void
  onRejectSection: (sectionId: string) => void
  /** Official moved on since this branch — user should update */
  isOfficialNewerThanBranch: boolean
  onUpdateToLatest: () => void
  rebaseSession: RebaseSessionState | null
  onRebaseChoose: (sectionId: string, choice: 'official' | 'mine') => void
  onApplyRebaseMerge: () => void
  /** Owner reviewing a collaborator’s submitted working copy (live session). */
  collabOwnerReview?: {
    submitterName: string
    submittedDocument: DocumentModel
    acceptedSectionIds: string[]
    rejectedSectionIds: string[]
    onAcceptSection: (sectionId: string) => void
    onRejectSection: (sectionId: string) => void
  } | null
  /** Collab server base URL; Co-Author calls POST /api/coauthor there. */
  coauthorApiBaseUrl?: string | null
}

function workspaceBadge(
  isWorkingCopy: boolean,
  workingStatus: WorkingDocumentStatus | undefined,
  collabOwnerReview: MainDocumentAreaProps['collabOwnerReview'],
): {
  label: string
  tone: WorkspaceBadgeTone
} {
  if (collabOwnerReview) return { label: `Review · ${collabOwnerReview.submitterName}`, tone: 'in_review' }
  if (!isWorkingCopy) return { label: 'Official Version', tone: 'official' }
  if (workingStatus === 'in_review') return { label: 'In Review', tone: 'in_review' }
  return { label: 'Working Copy', tone: 'working' }
}

export function MainDocumentArea({
  officialDocument,
  activeDocument,
  isWorkingCopy,
  workingStatus,
  readOnly,
  onSectionBodyChange,
  acceptedSectionIds,
  rejectedSectionIds,
  onAcceptSection,
  onRejectSection,
  isOfficialNewerThanBranch,
  onUpdateToLatest,
  rebaseSession,
  onRebaseChoose,
  onApplyRebaseMerge,
  collabOwnerReview,
  coauthorApiBaseUrl,
}: MainDocumentAreaProps) {
  const { label, tone } = workspaceBadge(isWorkingCopy, workingStatus, collabOwnerReview)
  const inReview = (isWorkingCopy && workingStatus === 'in_review') || Boolean(collabOwnerReview)
  const isEditing = isWorkingCopy && workingStatus === 'editing'
  const showOutdatedBanner = isEditing && isOfficialNewerThanBranch && !rebaseSession && !collabOwnerReview

  const rebaseCanApply =
    rebaseSession !== null &&
    rebaseSession.overlaps.length > 0 &&
    rebaseSession.overlaps.every((o) => rebaseSession.resolutions[o.sectionId] !== undefined)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-gray-100/80">
      <WorkspaceHeader
        documentTitle={activeDocument.documentTitle ?? 'Document'}
        versionLabel={label}
        badgeTone={tone}
      />
      {showOutdatedBanner ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 md:justify-between md:px-6"
          role="status"
        >
          <span className="font-medium">A newer official version is available</span>
          <button
            type="button"
            onClick={onUpdateToLatest}
            className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-800"
          >
            Update to Latest
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:px-8 md:py-10">
        {inReview ? (
          <ReviewCompareView
            officialDocument={officialDocument}
            submittedDocument={collabOwnerReview?.submittedDocument ?? activeDocument}
            acceptedSectionIds={collabOwnerReview?.acceptedSectionIds ?? acceptedSectionIds}
            rejectedSectionIds={collabOwnerReview?.rejectedSectionIds ?? rejectedSectionIds}
            onAcceptSection={collabOwnerReview?.onAcceptSection ?? onAcceptSection}
            onRejectSection={collabOwnerReview?.onRejectSection ?? onRejectSection}
          />
        ) : rebaseSession ? (
          <RebaseOverlapView
            overlaps={rebaseSession.overlaps}
            draftSections={rebaseSession.draftSections}
            resolutions={rebaseSession.resolutions}
            onChoose={onRebaseChoose}
            onApplyMerge={onApplyRebaseMerge}
            canApply={rebaseCanApply}
          />
        ) : (
          <DocumentViewer
            document={activeDocument}
            readOnly={readOnly}
            compareOfficial={
              isWorkingCopy && workingStatus === 'editing' ? officialDocument : undefined
            }
            onSectionBodyChange={onSectionBodyChange}
            coauthorApiBase={coauthorApiBaseUrl}
          />
        )}
      </div>
    </div>
  )
}
